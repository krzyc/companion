/*
 * This file is part of the Companion project
 * Copyright (c) 2018 Bitfocus AS
 * Authors: William Viker <william@bitfocus.io>, Håkon Nessjøen <haakon@bitfocus.io>
 *
 * This program is free software.
 * You should have received a copy of the MIT licence as well as the Bitfocus
 * Individual Contributor License Agreement for companion along with
 * this program.
 *
 * You can be released from the requirements of the license by purchasing
 * a commercial license. Buying such a license is mandatory as soon as you
 * develop commercial activities involving the Companion software without
 * disclosing the source code of your own applications.
 *
 */

import fs from 'fs-extra'
import { nanoid } from 'nanoid'
import { isPackaged } from '../Resources/Util.js'
import CoreBase from '../Core/Base.js'
import InstanceDefinitions from './Definitions.js'
import InstanceVariable from './Variable.js'
import path from 'path'
import ModuleHost, { ConnectionDebugLogRoom } from './Host.js'
import InstanceStatus, { InstanceStatusValue } from './Status.js'
import { ModuleManifest, validateManifest } from '@companion-module/base'
import { fileURLToPath } from 'url'
import { cloneDeep } from 'lodash-es'
import jsonPatch from 'fast-json-patch'
import { isLabelValid, makeLabelSafe } from '../Shared/Label.js'
import type { Registry, SocketClient } from '../tmp.js'

const InstancesRoom = 'instances'

interface ModuleDisplayInfo {
	id: string
	name: string
	version: string
	hasHelp: boolean
	bugUrl: string
	shortname: string
	manufacturer: string
	products: string[]
	keywords: string[]

	isLegacy?: boolean
}

export interface ModuleInfo {
	manifest: ModuleManifest
	basePath: string
	helpPath: string | null
	display: ModuleDisplayInfo
	isPackaged: boolean

	isOverride?: boolean
}

export interface InstanceStoreConfig {
	instance_type: string
	label: string
	config: unknown

	enabled: boolean
	sortOrder: number

	isFirstInit?: boolean
	lastUpgradeIndex?: number
}

export interface UiInstanceConfig {
	instance_type: string
	label: string
	enabled: boolean
	sortOrder: number

	// Runtime properties
	hasRecordActionsHandler: boolean
}

class Instance extends CoreBase {
	#lastClientJson: Record<string, UiInstanceConfig> | null = null

	variable: InstanceVariable
	definitions: InstanceDefinitions
	status: InstanceStatus
	moduleHost: ModuleHost

	/** Object of the known modules that can be loaded */
	known_modules = new Map<string, ModuleInfo>()
	/** Sometimes modules get renamed/merged. This lets that happen */
	module_renames = new Map<string, string>()

	store: { db: Record<string, InstanceStoreConfig | undefined> }

	constructor(registry: Registry) {
		super(registry, 'instance', 'Instance/Controller')

		this.variable = new InstanceVariable(registry)
		this.definitions = new InstanceDefinitions(registry)
		this.status = new InstanceStatus(registry)
		this.moduleHost = new ModuleHost(registry, this.status)

		this.store = {
			db: {},
		}

		this.store.db = this.db.getKey('instance', {})

		// Prepare for clients already
		this.commitChanges()

		this.registry.api_router.get('/help/module/:module_id/*', (req, res, next) => {
			const module_id = req.params.module_id.replace(/\.\.+/g, '')
			const file = req.params.module_id.replace(/\.\.+/g, '')

			const moduleInfo = this.known_modules.get(module_id)
			if (moduleInfo && moduleInfo.helpPath && moduleInfo.basePath) {
				const fullpath = path.join(moduleInfo.basePath, 'companion', file)
				if (file.match(/\.(jpe?g|gif|png|pdf)$/) && fs.existsSync(fullpath)) {
					// Send the file, then stop
					res.sendFile(fullpath)
					return
				}
			}

			// Try next handler
			next()
		})
	}

	getAllInstanceIds() {
		return Object.keys(this.store.db)
	}

	/**
	 * Handle an electron power event
	 * @param {string} event
	 */
	powerStatusChange(event: string) {
		if (event == 'resume') {
			this.logger.info('Power: Resuming')

			for (const id in this.store.db) {
				this.activate_module(id)
			}
		} else if (event == 'suspend') {
			this.logger.info('Power: Suspending')

			this.moduleHost.queueStopAllConnections().catch((e) => {
				this.logger.debug(`Error suspending instances: ${e?.message ?? e}`)
			})
		}
	}

	/**
	 * Initialise instances
	 * @param {string} extraModulePath - extra directory to search for modules
	 */
	async initInstances(extraModulePath: string): Promise<void> {
		this.logger.silly('instance_init', this.store.db)

		const rootPath = isPackaged() ? path.join(__dirname, '.') : fileURLToPath(new URL('../../', import.meta.url))

		const searchDirs = [
			// Paths to look for modules, lowest to highest priority
			path.resolve(path.join(rootPath, 'bundled-modules')),
		]

		const legacyCandidates = await this.#loadInfoForModulesInDir(path.join(rootPath, '/module-legacy/manifests'), false)

		// Start with 'legacy' candidates
		for (const candidate of legacyCandidates) {
			candidate.display.isLegacy = true
			this.known_modules.set(candidate.manifest.id, candidate)
		}

		// Load modules from other folders in order of priority
		for (const searchDir of searchDirs) {
			const candidates = await this.#loadInfoForModulesInDir(searchDir, false)
			for (const candidate of candidates) {
				// Replace any existing candidate
				this.known_modules.set(candidate.manifest.id, candidate)
			}
		}

		if (extraModulePath) {
			this.logger.info(`Looking for extra modules in: ${extraModulePath}`)
			const candidates = await this.#loadInfoForModulesInDir(extraModulePath, true)
			for (const candidate of candidates) {
				// Replace any existing candidate
				this.known_modules.set(candidate.manifest.id, {
					...candidate,
					isOverride: true,
				})
			}

			this.logger.info(`Found ${candidates.length} extra modules`)
		}

		// Figure out the redirects. We do this afterwards, to ensure we avoid collisions and stuff
		for (const id of Object.keys(this.known_modules).sort()) {
			const moduleInfo = this.known_modules.get(id)
			if (moduleInfo && Array.isArray(moduleInfo.manifest.legacyIds)) {
				if (moduleInfo.display.isLegacy) {
					// Handle legacy modules differently. They should never replace a new style one
					for (const legacyId of moduleInfo.manifest.legacyIds) {
						const otherInfo = this.known_modules.get(legacyId)
						if (!otherInfo || otherInfo.display.isLegacy) {
							// Other is not known or is legacy
							this.module_renames.set(legacyId, id)
							this.known_modules.delete(legacyId)
						}
					}
				} else {
					// These should replace anything
					for (const legacyId of moduleInfo.manifest.legacyIds) {
						this.module_renames.set(legacyId, id)
						this.known_modules.delete(legacyId)
					}
				}
			}
		}

		// Log the loaded modules
		const sortedModules = Array.from(this.known_modules.entries()).sort((a, b) => a[0].localeCompare(b[0]))
		for (const [_id, moduleInfo] of sortedModules) {
			if (moduleInfo.isOverride) {
				this.logger.info(
					`${moduleInfo.display.id}@${moduleInfo.display.version}: ${moduleInfo.display.name} (Overridden${
						moduleInfo.isPackaged ? ' & Packaged' : ''
					})`
				)
			} else {
				this.logger.debug(`${moduleInfo.display.id}@${moduleInfo.display.version}: ${moduleInfo.display.name}`)
			}
		}

		for (const id in this.store.db) {
			this.activate_module(id, false)
		}
	}

	setInstanceLabelAndConfig(
		id: string,
		newLabel: string | null,
		config: unknown,
		skip_notify_instance?: boolean
	): void {
		const entry = this.store.db[id]
		if (!entry) {
			this.logger.warn(`setInstanceLabelAndConfig id "${id}" does not exist!`)
			return
		}

		// Mark as definitely been initialised
		entry.isFirstInit = false

		// Update the config blob
		if (config) {
			entry.config = config
		}

		// Rename variables
		if (newLabel && entry.label != newLabel) {
			const oldLabel = entry.label
			entry.label = newLabel
			this.variable.instanceLabelRename(oldLabel, newLabel)
			this.definitions.updateVariablePrefixesForLabel(id, newLabel)
		}

		this.commitChanges()

		const instance = this.instance.moduleHost.getChild(id, true)
		if (newLabel) {
			this.instance.moduleHost.updateChildLabel(id, newLabel)
			if (instance) {
				instance.updateLabel(newLabel).catch((e: any) => {
					instance.logger.warn('Error updating instance label: ' + e.message)
				})
			}
		}

		if (config && instance && !skip_notify_instance) {
			instance.updateConfig(config).catch((e: any) => {
				instance.logger.warn('Error updating instance configuration: ' + e.message)
			})
		}

		this.logger.debug(`instance "${entry.label}" configuration updated`)
	}

	makeLabelUnique(prefix: string, ignoreId?: string): string {
		const knownLabels = new Set()
		for (const [id, obj] of Object.entries(this.store.db)) {
			if (id !== ignoreId && obj && obj.label) {
				knownLabels.add(obj.label)
			}
		}

		prefix = makeLabelSafe(prefix)

		let label = prefix
		let i = 1
		while (knownLabels.has(label)) {
			// Try the next
			label = `${prefix}_${++i}`
		}

		return label
	}

	addInstance(data: { type: string; product: string | undefined }, disabled: boolean): string | undefined {
		let module = data.type
		let product = data.product

		// Find the highest rank given to an instance
		const highestRank =
			Math.max(
				0,
				...Object.values(this.store.db)
					.filter((c): c is InstanceStoreConfig => !!c)
					.map((c) => c.sortOrder)
					.filter((n) => typeof n === 'number')
			) || 0

		const moduleInfo = this.known_modules.get(module)
		if (moduleInfo) {
			let id = nanoid()

			this.logger.info('Adding connection ' + module + ' ' + product)

			const config = (this.store.db[id] = {
				instance_type: module,
				sortOrder: highestRank + 1,
				label: this.makeLabelUnique(moduleInfo.display.shortname),
				isFirstInit: true,
				config: {
					product: product,
				},
				enabled: false,
			})

			if (disabled) {
				config.enabled = false
			}

			this.activate_module(id, true)

			this.logger.silly('instance_add', id)
			this.commitChanges()

			return id
		}

		return undefined
	}

	getLabelForInstance(id: string): string | undefined {
		return this.store.db[id]?.label
	}

	getIdForLabel(label: string): string | undefined {
		for (const [id, conf] of Object.entries(this.store.db)) {
			if (conf && conf.label === label) {
				return id
			}
		}
		return undefined
	}

	enableDisableInstance(id: string, state: boolean): void {
		const instanceConfig = this.store.db[id]
		if (instanceConfig) {
			const label = instanceConfig.label
			if (instanceConfig.enabled !== state) {
				this.logger.info((state ? 'Enable' : 'Disable') + ' instance ' + label)
				instanceConfig.enabled = state

				if (state === false) {
					this.moduleHost
						.queueStopConnection(id)
						.catch((e) => {
							this.logger.warn(`Error disabling instance ${label}: `, e)
						})
						.then(() => {
							this.status.updateInstanceStatus(id, null, 'Disabled')

							this.definitions.forgetInstance(id)
							this.variable.forgetInstance(id, label)
						})
				} else {
					this.status.updateInstanceStatus(id, null, 'Starting')
					this.activate_module(id)
				}

				this.commitChanges()
			} else {
				if (state === true) {
					this.logger.warn(id, 'warn', `Attempting to enable connection "${label}" that is already enabled`)
				} else {
					this.logger.warn(id, 'warn', `Attempting to disable connection "${label}" that is already disabled`)
				}
			}
		}
	}

	async deleteInstance(id: string): Promise<void> {
		const instanceConfig = this.store.db[id]
		if (!instanceConfig) return

		const label = instanceConfig.label
		this.logger.info(`Deleting instance: ${label ?? id}`)

		try {
			await this.moduleHost.queueStopConnection(id)
		} catch (e) {
			this.logger.debug(`Error while deleting instance "${label ?? id}": `, e)
		}

		this.status.forgetInstanceStatus(id)
		delete this.store.db[id]

		this.commitChanges()

		// forward cleanup elsewhere
		this.definitions.forgetInstance(id)
		this.variable.forgetInstance(id, label)
		this.controls.forgetInstance(id)
	}

	async deleteAllInstances() {
		const ps = []
		for (const instanceId of Object.keys(this.store.db)) {
			ps.push(this.deleteInstance(instanceId))
		}

		await Promise.all(ps)
	}

	/**
	 * Checks whether an instance_type has been renamed
	 * @param {string} instance_type
	 * @returns {string} the instance_type that should be used (often the provided parameter)
	 */
	verifyInstanceTypeIsCurrent(instance_type: string): string {
		return this.module_renames.get(instance_type) || instance_type
	}

	/**
	 * Get information for the metrics system about the current instances
	 */
	getInstancesMetrics() {
		const instancesCounts: Record<string, number> = {}

		const instanceIds = this.instance.getAllInstanceIds()
		for (const instanceId of instanceIds) {
			const instanceConfig = this.instance.getInstanceConfig(instanceId)
			if (instanceConfig && instanceConfig.enabled) {
				if (instancesCounts[instanceConfig.instance_type]) {
					instancesCounts[instanceConfig.instance_type]++
				} else {
					instancesCounts[instanceConfig.instance_type] = 1
				}
			}
		}

		return instancesCounts
	}

	/**
	 * Stop/destroy all running instances
	 */
	async destroyAllInstances() {
		return this.moduleHost.queueStopAllConnections()
	}

	/**
	 * Save the instances config to the db, and inform clients
	 * @access protected
	 */
	commitChanges() {
		this.db.setKey('instance', this.store.db)

		const newJson = cloneDeep(this.getClientJson())

		// Now broadcast to any interested clients
		if (this.io.countRoomMembers(InstancesRoom) > 0) {
			const patch = jsonPatch.compare(this.#lastClientJson || {}, newJson || {})
			if (patch.length > 0) {
				this.io.emitToRoom(InstancesRoom, `instances:patch`, patch)
			}
		}

		this.#lastClientJson = newJson
	}

	exportInstance(instanceId: string, clone = true) {
		const obj = this.store.db[instanceId]

		return clone ? cloneDeep(obj) : obj
	}
	exportAll(clone = true) {
		const obj = this.store.db
		return clone ? cloneDeep(obj) : obj
	}

	/**
	 * Get the status of an instance
	 * @param {String} instance_id
	 * @returns {number} ??
	 */
	getInstanceStatus(instance_id: string): InstanceStatusValue | undefined {
		return this.status.getInstanceStatus(instance_id)
	}

	/**
	 * Get the config object of an instance
	 * @param {String} instance_id
	 * @returns {Object} ??
	 */
	getInstanceConfig(instance_id: string) {
		return this.store.db[instance_id]
	}

	/**
	 * Start an instance running
	 * @param {string} id
	 * @param {boolean} is_being_created
	 */
	activate_module(id: string, is_being_created?: boolean) {
		const config = this.store.db[id]
		if (!config) throw new Error('Cannot activate unknown module')

		config.instance_type = this.verifyInstanceTypeIsCurrent(config.instance_type)

		if (config.enabled === false) {
			this.logger.silly("Won't load disabled module " + id + ' (' + config.instance_type + ')')
			return
		}

		// Ensure that the label is valid according to the new rules
		// This is excessive to do at every activation, but it needs to be done once everything is loaded, not when upgrades are run
		const safeLabel = makeLabelSafe(config.label)
		if (!is_being_created && safeLabel !== config.label) {
			this.setInstanceLabelAndConfig(id, safeLabel, null, true)
		}

		const moduleInfo = this.known_modules.get(config.instance_type)
		if (!moduleInfo) {
			this.logger.error('Configured instance ' + config.instance_type + ' could not be loaded, unknown module')
		} else {
			this.moduleHost.queueRestartConnection(id, config, moduleInfo).catch((e) => {
				this.logger.error('Configured instance ' + config.instance_type + ' failed to start: ', e)
			})
		}
	}

	/**
	 * Setup a new socket client's events
	 * @param {SocketIO} client - the client socket
	 * @access public
	 */
	clientConnect(client: SocketClient): void {
		this.variable.clientConnect(client)
		this.definitions.clientConnect(client)
		this.status.clientConnect(client)

		client.onPromise('instances:subscribe', () => {
			client.join(InstancesRoom)

			return this.#lastClientJson || this.getClientJson()
		})
		client.onPromise('instances:unsubscribe', () => {
			client.leave(InstancesRoom)
		})

		client.onPromise('modules:get', () => {
			return Array.from(this.known_modules.values()).map((mod) => mod.display)
		})

		client.onPromise('instances:edit', async (id: string) => {
			const instance = this.instance.moduleHost.getChild(id)
			if (instance) {
				try {
					const fields = await instance.requestConfigFields()

					const instanceConf = this.store.db[id]

					return {
						fields,
						label: instanceConf?.label,
						config: instanceConf?.config,
						instance_type: instanceConf?.instance_type,
					}
				} catch (e: any) {
					this.logger.silly(`Failed to load instance config_fields: ${e.message}`)
					return null
				}
			} else {
				// Unknown instance
				return null
			}
		})

		client.onPromise('instances:set-config', (id: string, label: string, config: unknown) => {
			const idUsingLabel = this.getIdForLabel(label)
			if (idUsingLabel && idUsingLabel !== id) {
				return 'duplicate label'
			}

			if (!isLabelValid(label)) {
				return 'invalid label'
			}

			this.setInstanceLabelAndConfig(id, label, config)

			return null
		})

		client.onPromise('instances:set-enabled', (id: string, state: boolean) => {
			this.enableDisableInstance(id, !!state)
		})

		client.onPromise('instances:delete', async (id: string) => {
			await this.deleteInstance(id)
		})

		client.onPromise('instances:add', (module: { type: string; product: string | undefined }) => {
			const id = this.addInstance(module, false)
			return id
		})

		client.onPromise('instances:get-help', async (module_id: string) => {
			try {
				const res = await this.getHelpForModule(module_id)
				if (res) {
					return [null, res]
				} else {
					return ['nofile', null]
				}
			} catch (err) {
				this.logger.silly(`Error loading help for ${module_id}`)
				this.logger.silly(err)
				return ['nofile', null]
			}
		})

		client.onPromise('instances:set-order', async (instanceIds: string[]) => {
			if (!Array.isArray(instanceIds)) throw new Error('Expected array of ids')

			// This is a bit naive, but should be sufficient if the client behaves

			// Update the order based on the ids provided
			instanceIds.forEach((id, index) => {
				const entry = this.store.db[id]
				if (entry) entry.sortOrder = index
			})

			// Make sure all not provided are at the end in their original order
			const allKnownIds = Object.entries(this.store.db)
				.sort(([, a], [, b]) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0))
				.map(([id]) => id)
			let nextIndex = instanceIds.length
			for (const id of allKnownIds) {
				if (!instanceIds.includes(id)) {
					const entry = this.store.db[id]
					if (entry) entry.sortOrder = nextIndex++
				}
			}

			this.commitChanges()
		})

		client.onPromise('connection-debug:subscribe', (connectionId: string) => {
			if (!this.store.db[connectionId]) throw new Error('Unknown connection')

			client.join(ConnectionDebugLogRoom(connectionId))
		})

		client.onPromise('connection-debug:unsubscribe', (connectionId: string) => {
			client.leave(ConnectionDebugLogRoom(connectionId))
		})
	}

	getClientJson(): Record<string, UiInstanceConfig> {
		const result: Record<string, UiInstanceConfig> = {}

		for (const [id, config] of Object.entries(this.store.db)) {
			if (config) {
				result[id] = {
					instance_type: config.instance_type,
					label: config.label,
					enabled: config.enabled,
					sortOrder: config.sortOrder,

					// Runtime properties
					hasRecordActionsHandler: false,
				}

				const instance = this.moduleHost.getChild(id)
				if (instance) {
					result[id].hasRecordActionsHandler = instance.hasRecordActionsHandler
				}
			}
		}

		return result
	}

	/**
	 * Load the help markdown file for a specified module_id
	 * @access public
	 * @param {string} module_id
	 */
	async getHelpForModule(module_id: string): Promise<{ markdown: string; baseUrl: string } | undefined> {
		const moduleInfo = this.known_modules.get(module_id)
		if (moduleInfo && moduleInfo.helpPath) {
			const stats = await fs.stat(moduleInfo.helpPath)
			if (stats.isFile()) {
				const data = await fs.readFile(moduleInfo.helpPath)
				return {
					markdown: data.toString(),
					baseUrl: `/int/help/module/${module_id}/`,
				}
			} else {
				this.logger.silly(`Error loading help for ${module_id}`, moduleInfo.helpPath)
				this.logger.silly('Not a file')
				return undefined
			}
		} else {
			return undefined
		}
	}

	/**
	 * Load information about all modules in a directory
	 * @access private
	 * @param {string} searchDir - Path to search for modules
	 * @param {boolean} checkForPackaged - Whether to check for a packaged version
	 */
	async #loadInfoForModulesInDir(searchDir: string, checkForPackaged: boolean): Promise<ModuleInfo[]> {
		if (await fs.pathExists(searchDir)) {
			const candidates = await fs.readdir(searchDir)

			const ps = []

			for (const candidate of candidates) {
				const candidatePath = path.join(searchDir, candidate)
				ps.push(this.#loadInfoForModule(candidatePath, checkForPackaged))
			}

			const res = await Promise.all(ps)
			return res.filter((v): v is ModuleInfo => !!v)
		} else {
			return []
		}
	}

	/**
	 * Load information about a module
	 * @access private
	 * @param {string} fullpath - Fullpath to the module
	 * @param {boolean} checkForPackaged - Whether to check for a packaged version
	 */
	async #loadInfoForModule(fullpath: string, checkForPackaged: boolean): Promise<ModuleInfo | undefined> {
		try {
			let isPackaged = false
			const pkgDir = path.join(fullpath, 'pkg')
			if (
				checkForPackaged &&
				(await fs.pathExists(path.join(fullpath, 'DEBUG-PACKAGED'))) &&
				(await fs.pathExists(pkgDir))
			) {
				fullpath = pkgDir
				isPackaged = true
			}

			const manifestPath = path.join(fullpath, 'companion/manifest.json')
			if (!(await fs.pathExists(manifestPath))) {
				this.logger.silly(`Ignoring "${fullpath}", as it is not a new module`)
				return
			}
			const manifestJsonStr = await fs.readFile(manifestPath)
			const manifestJson = JSON.parse(manifestJsonStr.toString())

			validateManifest(manifestJson)

			const helpPath = path.join(fullpath, 'companion/HELP.md')

			const hasHelp = await fs.pathExists(helpPath)
			const moduleDisplay: ModuleDisplayInfo = {
				id: manifestJson.id,
				name: manifestJson.manufacturer + ':' + manifestJson.products.join(';'),
				version: manifestJson.version,
				hasHelp: hasHelp,
				bugUrl: manifestJson.bugs || manifestJson.repository,
				shortname: manifestJson.shortname,
				manufacturer: manifestJson.manufacturer,
				products: manifestJson.products,
				keywords: manifestJson.keywords,
			}

			const moduleManifestExt: ModuleInfo = {
				manifest: manifestJson,
				basePath: path.resolve(fullpath),
				helpPath: hasHelp ? helpPath : null,
				display: moduleDisplay,
				isPackaged: isPackaged,
			}

			this.logger.silly(`found module ${moduleDisplay.id}@${moduleDisplay.version}`)

			return moduleManifestExt
		} catch (e) {
			this.logger.silly(`Error loading module from ${fullpath}`, e)
			this.logger.error(`Error loading module from "${fullpath}": ` + e)
			return undefined
		}
	}
}

export default Instance
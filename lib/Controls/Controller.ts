import { cloneDeep } from 'lodash-es'
import CoreBase from '../Core/Base.js'
import ControlButtonNormal from './ControlTypes/Button/Normal.js'
import ControlButtonPageDown from './ControlTypes/PageDown.js'
import ControlButtonPageNumber from './ControlTypes/PageNumber.js'
import ControlButtonPageUp from './ControlTypes/PageUp.js'
import { CreateBankControlId, CreateTriggerControlId, ParseControlId } from '../Shared/ControlId.js'
import ControlBase, {
	ControlBaseWithActions,
	ControlBaseWithDynamicActionSets,
	ControlBaseWithEvents,
	ControlBaseWithFeedbacks,
	ControlBaseWithSteps,
	ControlConfigRoom,
} from './ControlBase.js'
import ActionRunner from './ActionRunner.js'
import ActionRecorder from './ActionRecorder.js'
import ControlTrigger, { TriggerInfo } from './ControlTypes/Triggers/Trigger.js'
import { nanoid } from 'nanoid'
import TriggerEvents from './TriggerEvents.js'
import type { Registry, SocketClient } from '../tmp.js'
import { MAX_BUTTONS } from '../Resources/Constants.js'
import { CompanionAdvancedFeedbackResult } from '@companion-module/base'

export const TriggersListRoom = 'triggers:list'

type SomeControl = ControlBase<any, any> &
	Partial<ControlBaseWithActions> &
	Partial<ControlBaseWithDynamicActionSets> &
	Partial<ControlBaseWithSteps> &
	Partial<ControlBaseWithFeedbacks<unknown>> &
	Partial<ControlBaseWithEvents>
// | ControlButtonNormal
// | ControlButtonPageDown
// | ControlButtonPageNumber
// | ControlButtonPageUp
// | ControlTrigger

/**
 * The class that manages the controls
 *
 * @extends CoreBase
 * @author Håkon Nessjøen <haakon@bitfocus.io>
 * @author Keith Rocheck <keith.rocheck@gmail.com>
 * @author William Viker <william@bitfocus.io>
 * @author Julian Waller <me@julusian.co.uk>
 * @since 1.0.4
 * @copyright 2022 Bitfocus AS
 * @license
 * This program is free software.
 * You should have received a copy of the MIT licence as well as the Bitfocus
 * Individual Contributor License Agreement for Companion along with
 * this program.
 *
 * You can be released from the requirements of the license by purchasing
 * a commercial license. Buying such a license is mandatory as soon as you
 * develop commercial activities involving the Companion software without
 * disclosing the source code of your own applications.
 */
class ControlsController extends CoreBase {
	/**
	 * Actions runner
	 * @type {ActionRunner}
	 * @access public
	 */
	actions

	/**
	 * Actions recorder
	 * @type {ActionRecorder}
	 * @access public
	 */
	actionRecorder

	/**
	 * The currently configured controls
	 * @access private
	 */
	#controls: Record<string, SomeControl | undefined> = {}

	/**
	 * Triggers events
	 * @type {TriggerEvents}
	 * @access public
	 */
	triggers: TriggerEvents

	/**
	 * @param {Registry} registry - the application core
	 */
	constructor(registry: Registry) {
		super(registry, 'controls', 'Controls/Controller')

		this.actions = new ActionRunner(registry)
		this.actionRecorder = new ActionRecorder(registry)
		this.triggers = new TriggerEvents()

		// Init all the control classes
		const config = this.db.getKey('controls', {})
		for (const [controlId, controlObj] of Object.entries(config)) {
			if (controlObj && controlObj.type) {
				const inst = this.#createClassForControl(controlId, 'all', controlObj.type, controlObj, false)
				if (inst) this.#controls[controlId] = inst
			}
		}
	}

	/**
	 * Check the instance-status of every control
	 * @access public
	 */
	checkAllStatus(): void {
		for (const control of Object.values(this.#controls)) {
			if (typeof control?.checkButtonStatus === 'function') {
				control.checkButtonStatus()
			}
		}
	}

	/**
	 * Setup a new socket client's events
	 * @param {SocketIO} client - the client socket
	 * @access public
	 */
	clientConnect(client: SocketClient) {
		this.actionRecorder.clientConnect(client)

		this.triggers.emit('client_connect')

		client.onPromise('controls:subscribe', (controlId: string) => {
			client.join(ControlConfigRoom(controlId))

			setImmediate(() => {
				// Send the preview image shortly after
				const parsedId = ParseControlId(controlId)
				if (parsedId?.type === 'bank') {
					const img = this.graphics.getBank(parsedId.page, parsedId.bank)
					client.emit(`controls:preview-${controlId}`, img?.buffer)
				}
			})

			const control = this.getControl(controlId)
			return {
				config: control?.toJSON(false),
				runtime: control?.toRuntimeJSON(),
			}
		})

		client.onPromise('controls:unsubscribe', (controlId: string) => {
			client.leave(ControlConfigRoom(controlId))
		})

		client.onPromise('controls:reset', (controlId: string, type: string) => {
			return this.resetControl(controlId, type)
		})
		client.onPromise('controls:copy', (fromControlId: string, toControlId: string) => {
			if (!this.#validateBankControlId(toControlId)) {
				// Control id is not valid!
				return false
			}

			const fromControl = this.getControl(fromControlId)
			if (fromControl && fromControlId !== toControlId) {
				const controlJson = fromControl.toJSON(true)

				const newControl = this.#createClassForControl(toControlId, 'bank', controlJson.type, controlJson, true)
				if (newControl) {
					this.resetControl(toControlId)

					this.#controls[toControlId] = newControl
					return true
				}
			}

			return false
		})
		client.onPromise('controls:move', (fromControlId: string, toControlId: string) => {
			if (!this.#validateBankControlId(toControlId)) {
				// Control id is not valid!
				return false
			}

			const fromControl = this.getControl(fromControlId)
			if (fromControl && fromControlId !== toControlId) {
				const controlJson = fromControl.toJSON(true)

				const newControl = this.#createClassForControl(toControlId, 'bank', controlJson.type, controlJson, true)
				if (newControl) {
					this.resetControl(toControlId)
					this.resetControl(fromControlId)

					this.#controls[toControlId] = newControl
					return true
				}
			}

			return false
		})
		client.onPromise('controls:swap', (controlIdA: string, controlIdB: string) => {
			if (!this.#validateBankControlId(controlIdA) || !this.#validateBankControlId(controlIdB)) {
				// Control id is not valid!
				return false
			}

			const controlA = this.getControl(controlIdA)
			const controlB = this.getControl(controlIdB)

			// shortcut
			if (!controlA && !controlB) return true

			const controlAJson = controlA ? controlA.toJSON(true) : undefined
			const controlBJson = controlB ? controlB.toJSON(true) : undefined

			// destroy old ones
			this.resetControl(controlIdA)
			this.resetControl(controlIdB)

			// create new controls
			if (controlAJson) {
				const newControlA = this.#createClassForControl(controlIdB, 'bank', controlAJson.type, controlAJson, true)
				if (newControlA) this.#controls[controlIdB] = newControlA
			}
			if (controlBJson) {
				const newControlB = this.#createClassForControl(controlIdA, 'bank', controlBJson.type, controlBJson, true)
				if (newControlB) this.#controls[controlIdA] = newControlB
			}

			return true
		})

		client.onPromise('controls:set-style-fields', (controlId: string, diff: Partial<unknown>) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.styleSetFields === 'function') {
				return control.styleSetFields(diff)
			} else {
				throw new Error(`Control "${controlId}" does not support config`)
			}
		})

		client.onPromise('controls:set-options-field', (controlId: string, key: string, value: any) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.optionsSetField === 'function') {
				return control.optionsSetField(key, value)
			} else {
				throw new Error(`Control "${controlId}" does not support options`)
			}
		})

		client.onPromise('controls:feedback:add', (controlId: string, instanceId: string, feedbackId: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackAdd === 'function') {
				const feedbackItem = this.instance.definitions.createFeedbackItem(
					instanceId,
					feedbackId,
					control.feedbacks.isBooleanOnly
				)
				if (feedbackItem) {
					return control.feedbacks.feedbackAdd(feedbackItem)
				} else {
					return false
				}
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})

		client.onPromise('controls:feedback:learn', (controlId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackLearn === 'function') {
				return control.feedbacks.feedbackLearn(id)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})

		client.onPromise('controls:feedback:enabled', (controlId: string, id: string, enabled: boolean) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackEnabled === 'function') {
				return control.feedbacks.feedbackEnabled(id, enabled)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})

		client.onPromise('controls:feedback:remove', (controlId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackRemove === 'function') {
				return control.feedbacks.feedbackRemove(id)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})

		client.onPromise('controls:feedback:duplicate', (controlId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackDuplicate === 'function') {
				return control.feedbacks.feedbackDuplicate(id)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})

		client.onPromise('controls:feedback:set-option', (controlId: string, id: string, key: string, value: any) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackSetOptions === 'function') {
				return control.feedbacks.feedbackSetOptions(id, key, value)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})

		client.onPromise('controls:feedback:reorder', (controlId: string, oldIndex: number, newIndex: number) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackReorder === 'function') {
				return control.feedbacks.feedbackReorder(oldIndex, newIndex)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})
		client.onPromise('controls:feedback:set-style-selection', (controlId: string, id: string, selected: string[]) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackSetStyleSelection === 'function') {
				return control.feedbacks.feedbackSetStyleSelection(id, selected)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})
		client.onPromise('controls:feedback:set-style-value', (controlId: string, id: string, key: string, value: any) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (control.feedbacks && typeof control.feedbacks.feedbackSetStyleValue === 'function') {
				return control.feedbacks.feedbackSetStyleValue(id, key, value)
			} else {
				throw new Error(`Control "${controlId}" does not support feedbacks`)
			}
		})

		client.onPromise('controls:hot-press', (controlId: string, direction: boolean, deviceId?: string) => {
			this.logger.silly(`being told from gui to hot press ${controlId} ${direction} ${deviceId}`)

			this.pressControl(controlId, direction, deviceId ? `hot:${deviceId}` : undefined)
		})

		client.onPromise('controls:hot-rotate', (controlId: string, direction: boolean, deviceId?: string) => {
			this.logger.silly(`being told from gui to hot rotate ${controlId} ${direction} ${deviceId}`)

			this.rotateControl(controlId, direction, deviceId ? `hot:${deviceId}` : undefined)
		})

		client.onPromise(
			'controls:action:add',
			(controlId: string, stepId: number, setId: string, instanceId: string, actionId: string) => {
				const control = this.getControl(controlId)
				if (!control) return false

				if (typeof control.actionAdd === 'function') {
					const actionItem = this.instance.definitions.createActionItem(instanceId, actionId)
					if (actionItem) {
						return control.actionAdd(stepId, setId, actionItem)
					} else {
						return false
					}
				} else {
					throw new Error(`Control "${controlId}" does not support actions`)
				}
			}
		)

		client.onPromise('controls:action:learn', (controlId: string, stepId: number, setId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.actionLearn === 'function') {
				return control.actionLearn(stepId, setId, id)
			} else {
				throw new Error(`Control "${controlId}" does not support actions`)
			}
		})

		client.onPromise(
			'controls:action:enabled',
			(controlId: string, stepId: number, setId: string, id: string, enabled: boolean) => {
				const control = this.getControl(controlId)
				if (!control) return false

				if (typeof control.actionEnabled === 'function') {
					return control.actionEnabled(stepId, setId, id, enabled)
				} else {
					throw new Error(`Control "${controlId}" does not support actions`)
				}
			}
		)

		client.onPromise('controls:action:remove', (controlId: string, stepId: number, setId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.actionRemove === 'function') {
				return control.actionRemove(stepId, setId, id)
			} else {
				throw new Error(`Control "${controlId}" does not support actions`)
			}
		})

		client.onPromise('controls:action:duplicate', (controlId: string, stepId: number, setId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.actionDuplicate === 'function') {
				return control.actionDuplicate(stepId, setId, id)
			} else {
				throw new Error(`Control "${controlId}" does not support actions`)
			}
		})

		client.onPromise(
			'controls:action:set-delay',
			(controlId: string, stepId: number, setId: string, id: string, delay: number) => {
				const control = this.getControl(controlId)
				if (!control) return false

				if (typeof control.actionSetDelay === 'function') {
					return control.actionSetDelay(stepId, setId, id, delay)
				} else {
					throw new Error(`Control "${controlId}" does not support actions`)
				}
			}
		)

		client.onPromise(
			'controls:action:set-option',
			(controlId: string, stepId: number, setId: string, id: string, key: string, value: any) => {
				const control = this.getControl(controlId)
				if (!control) return false

				if (typeof control.actionSetOption === 'function') {
					return control.actionSetOption(stepId, setId, id, key, value)
				} else {
					throw new Error(`Control "${controlId}" does not support actions`)
				}
			}
		)
		client.onPromise(
			'controls:action:reorder',
			(
				controlId: string,
				dragStepId: string,
				dragSetId: string,
				dragIndex: number,
				dropStepId: string,
				dropSetId: string,
				dropIndex: number
			) => {
				const control = this.getControl(controlId)
				if (!control) return false

				if (typeof control.actionReorder === 'function') {
					return control.actionReorder(dragStepId, dragSetId, dragIndex, dropStepId, dropSetId, dropIndex)
				} else {
					throw new Error(`Control "${controlId}" does not support actions`)
				}
			}
		)
		client.onPromise('controls:action-set:add', (controlId: string, stepId: number) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.actionSetAdd === 'function') {
				return control.actionSetAdd(stepId)
			} else {
				throw new Error(`Control "${controlId}" does not support this operation`)
			}
		})
		client.onPromise('controls:action-set:remove', (controlId: string, stepId: number, setId: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.actionSetRemove === 'function') {
				return control.actionSetRemove(stepId, setId)
			} else {
				throw new Error(`Control "${controlId}" does not support this operation`)
			}
		})

		client.onPromise(
			'controls:action-set:rename',
			(controlId: string, stepId: number, oldSetId: string, newSetId: string) => {
				const control = this.getControl(controlId)
				if (!control) return false

				if (typeof control.actionSetRename === 'function') {
					return control.actionSetRename(stepId, oldSetId, newSetId)
				} else {
					throw new Error(`Control "${controlId}" does not support this operation`)
				}
			}
		)

		client.onPromise(
			'controls:action-set:set-run-while-held',
			(controlId: string, stepId: number, setId: string, runWhileHeld: boolean) => {
				const control = this.getControl(controlId)
				if (!control) return false

				if (typeof control.actionSetRunWhileHeld === 'function') {
					return control.actionSetRunWhileHeld(stepId, setId, runWhileHeld)
				} else {
					throw new Error(`Control "${controlId}" does not support this operation`)
				}
			}
		)

		client.onPromise('controls:step:add', (controlId: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.stepAdd === 'function') {
				return control.stepAdd()
			} else {
				throw new Error(`Control "${controlId}" does not support steps`)
			}
		})
		client.onPromise('controls:step:remove', (controlId: string, stepId: number) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.stepRemove === 'function') {
				return control.stepRemove(stepId)
			} else {
				throw new Error(`Control "${controlId}" does not support steps`)
			}
		})

		client.onPromise('controls:step:swap', (controlId: string, stepId1: string, stepId2: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.stepSwap === 'function') {
				return control.stepSwap(stepId1, stepId2)
			} else {
				throw new Error(`Control "${controlId}" does not support steps`)
			}
		})

		client.onPromise('controls:step:set-next', (controlId: string, stepId: number) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.stepSelectNext === 'function') {
				return control.stepSelectNext(stepId)
			} else {
				throw new Error(`Control "${controlId}" does not support steps`)
			}
		})

		client.onPromise('triggers:subscribe', () => {
			client.join(TriggersListRoom)

			const triggers: Record<string, TriggerInfo> = {}

			for (const [controlId, control] of Object.entries(this.#controls)) {
				if (control?.type === 'trigger') {
					const trigger = control as ControlTrigger
					if (typeof trigger.toTriggerJSON === 'function') {
						triggers[controlId] = trigger.toTriggerJSON()
					}
				}
			}

			return triggers
		})
		client.onPromise('triggers:unsubscribe', () => {
			client.leave(TriggersListRoom)
		})
		client.onPromise('triggers:create', () => {
			const controlId = CreateTriggerControlId(nanoid())

			const newControl = new ControlTrigger(this.registry, this.triggers, controlId, null, false)
			this.#controls[controlId] = newControl

			// Add trigger to the end of the list
			const allTriggers = Object.values(this.getAllControls()).filter(
				(control): control is ControlTrigger => control?.type === 'trigger'
			)
			const maxRank = Math.max(0, ...allTriggers.map((control) => control.options.sortOrder))
			newControl.optionsSetField('sortOrder', maxRank, true)

			// Ensure it is stored to the db
			newControl.commitChange()

			return controlId
		})
		client.onPromise('triggers:delete', (controlId: string) => {
			if (!this.#validateTriggerControlId(controlId)) {
				// Control id is not valid!
				return false
			}

			const control = this.getControl(controlId)
			if (control) {
				control.destroy()

				delete this.#controls[controlId]

				this.db.setKey(['controls', controlId], undefined)

				return true
			}

			return false
		})
		client.onPromise('triggers:clone', (controlId: string) => {
			if (!this.#validateTriggerControlId(controlId)) {
				// Control id is not valid!
				return false
			}

			const newControlId = CreateTriggerControlId(nanoid())

			const fromControl = this.getControl(controlId)
			if (fromControl) {
				const controlJson = fromControl.toJSON(true)

				const newControl = this.#createClassForControl(newControlId, 'trigger', controlJson.type, controlJson, true)
				if (newControl) {
					this.#controls[newControlId] = newControl

					return newControlId
				}
			}

			return false
		})
		client.onPromise('triggers:test', (controlId: string) => {
			if (!this.#validateTriggerControlId(controlId)) {
				// Control id is not valid!
				return false
			}

			const control = this.getControl(controlId)
			if (control) {
				control.executeActions(Date.now(), true)
			}

			return false
		})
		client.onPromise('triggers:set-order', (triggerIds: string[]) => {
			if (!Array.isArray(triggerIds)) throw new Error('Expected array of ids')

			triggerIds = triggerIds.filter((id) => this.#validateTriggerControlId(id))

			// This is a bit naive, but should be sufficient if the client behaves

			// Update the order based on the ids provided
			triggerIds.forEach((id, index) => {
				const control = this.getControl(id)
				if (control && typeof control.optionsSetField === 'function') control.optionsSetField('sortOrder', index, true)
			})

			// Fill in for any which weren't specified
			const updatedTriggerIds = new Set(triggerIds)
			const triggerControls = Object.values(this.getAllControls()).filter(
				(c): c is ControlTrigger => c?.type === 'trigger'
			)
			triggerControls.sort((a, b) => a.options.sortOrder - b.options.sortOrder)

			let nextIndex = triggerIds.length
			for (const control of triggerControls) {
				if (control && !updatedTriggerIds.has(control.controlId) && typeof control.optionsSetField === 'function') {
					control.optionsSetField('sortOrder', nextIndex++, true)
				}
			}

			return true
		})

		client.onPromise('controls:event:add', (controlId: string, eventType: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.eventAdd === 'function') {
				const feedbackItem = this.instance.definitions.createEventItem(eventType)
				if (feedbackItem) {
					return control.eventAdd(feedbackItem)
				} else {
					return false
				}
			} else {
				throw new Error(`Control "${controlId}" does not support events`)
			}
		})

		client.onPromise('controls:event:enabled', (controlId: string, id: string, enabled: boolean) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.eventEnabled === 'function') {
				return control.eventEnabled(id, enabled)
			} else {
				throw new Error(`Control "${controlId}" does not support events`)
			}
		})

		client.onPromise('controls:event:remove', (controlId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.eventRemove === 'function') {
				return control.eventRemove(id)
			} else {
				throw new Error(`Control "${controlId}" does not support events`)
			}
		})

		client.onPromise('controls:event:duplicate', (controlId: string, id: string) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.eventDuplicate === 'function') {
				return control.eventDuplicate(id)
			} else {
				throw new Error(`Control "${controlId}" does not support events`)
			}
		})

		client.onPromise('controls:event:set-option', (controlId: string, id: string, key: string, value: any) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.eventSetOptions === 'function') {
				return control.eventSetOptions(id, key, value)
			} else {
				throw new Error(`Control "${controlId}" does not support events`)
			}
		})

		client.onPromise('controls:event:reorder', (controlId: string, oldIndex: number, newIndex: number) => {
			const control = this.getControl(controlId)
			if (!control) return false

			if (typeof control.eventReorder === 'function') {
				return control.eventReorder(oldIndex, newIndex)
			} else {
				throw new Error(`Control "${controlId}" does not support events`)
			}
		})
	}

	/**
	 * Create a new control class isntance
	 * @param {string} controlId Id of the control
	 * @param {boolean} category 'bank' | 'trigger' | 'all'
	 * @param {string} controlType The type of the control
	 * @param {object | null} controlObj The existing configuration of the control, or null if it is a new control. Note: the control must be given a clone of an object
	 * @param {boolean} isImport Whether this is an import, and needs additional processing
	 * @returns
	 * @access private
	 */
	#createClassForControl(
		controlId: string,
		category: 'all' | 'bank' | 'trigger',
		controlType: string,
		controlObj,
		isImport: boolean
	): ControlBase<any, any> | null {
		if (category === 'all' || category === 'bank') {
			switch (controlType) {
				case 'button':
					return new ControlButtonNormal(this.registry, controlId, controlObj, isImport)
				case 'pagenum':
					return new ControlButtonPageNumber(this.registry, controlId, controlObj, isImport)
				case 'pageup':
					return new ControlButtonPageUp(this.registry, controlId, controlObj, isImport)
				case 'pagedown':
					return new ControlButtonPageDown(this.registry, controlId, controlObj, isImport)
			}
		}

		if (category === 'all' || category === 'trigger') {
			switch (controlType) {
				case 'trigger':
					return new ControlTrigger(this.registry, this.triggers, controlId, controlObj, isImport)
			}
		}

		// Unknown type
		this.logger.warn(`Cannot create control "${controlId}" of unknown type "${controlType}"`)
		return null
	}

	/**
	 * Get the export for all the controls
	 * @param {boolean} clone
	 * @returns
	 * @access public
	 */
	exportAll(clone = true) {
		const result = {}

		for (const [controlId, control] of Object.entries(this.#controls)) {
			if (control) {
				result[controlId] = control.toJSON(false)
			}
		}

		return clone ? cloneDeep(result) : result
	}

	/**
	 * Get the export for all the controls
	 * @param {boolean} clone
	 * @returns
	 * @access public
	 */
	exportPage(page: number, clone = true) {
		const result = {}

		for (let bank = 1; bank <= MAX_BUTTONS; bank++) {
			const controlId = CreateBankControlId(page, bank)
			const control = this.getControl(controlId)
			if (control) result[controlId] = control.toJSON(clone)
		}

		return result
	}

	/**
	 * Update all controls to forget an instance
	 * @param {string} instanceId
	 * @access public
	 */
	forgetInstance(instanceId: string): void {
		for (const control of Object.values(this.#controls)) {
			if (typeof control?.forgetInstance === 'function') {
				control.forgetInstance(instanceId)
			}
		}
	}

	/**
	 * Get all of the populated controls
	 * @returns
	 * @access public
	 */
	getAllControls() {
		return {
			// Shallow clone
			...this.#controls,
		}
	}

	/**
	 * Get a control if it has been populated
	 * @param {string} controlId
	 * @returns
	 * @access public
	 */
	getControl(controlId: string): SomeControl | undefined {
		return this.#controls[controlId]
	}

	/**
	 * Import a control
	 * @param {string} controlId Id of the control/location
	 * @param {object} definition object to import
	 * @returns
	 * @access public
	 */
	importControl(controlId: string, definition) {
		if (!this.#validateBankControlId(controlId)) {
			// Control id is not valid!
			return false
		}

		const newControl = this.#createClassForControl(controlId, 'bank', definition.type, definition, true)
		if (newControl) {
			this.resetControl(controlId)
			this.#controls[controlId] = newControl

			// Ensure it is stored to the db
			newControl.commitChange()

			return true
		}

		return false
	}

	/**
	 * Propogate variable changes to the banks
	 * @param {Object} changedVariables - variables with text changes
	 * @param {Array} removedVariables - variables that have been removed
	 * @access public
	 */
	onVariablesChanged(changedVariables: Record<string, any>, removedVariables: string[]): void {
		const allChangedVariables = [...removedVariables, ...Object.keys(changedVariables)]

		// Inform triggers of the change
		this.triggers.emit('variables_changed', new Set(allChangedVariables))

		if (allChangedVariables.length > 0) {
			for (const control of Object.values(this.#controls)) {
				if (control && typeof control.onVariablesChanged === 'function') {
					control.onVariablesChanged(allChangedVariables)
				}
			}
		}
	}

	/**
	 * Execute a press of a control
	 * @param {string} controlId Id of the control
	 * @param {boolean} pressed Whether the control is pressed
	 * @param {string | undefined} deviceId The surface that intiated this press
	 * @returns {boolean} success
	 * @access public
	 */
	pressControl(controlId: string, pressed: boolean, deviceId: string | undefined) {
		const control = this.getControl(controlId)
		if (control && typeof control.pressControl === 'function') {
			this.triggers.emit('control_press', controlId, pressed, deviceId)

			control.pressControl(pressed, deviceId)

			return true
		}

		return false
	}

	/**
	 * Execute rotation of a control
	 * @param {string} controlId Id of the control
	 * @param {boolean} direction Whether the control is rotated to the right
	 * @param {string | undefined} deviceId The surface that intiated this rotate
	 * @returns {boolean} success
	 * @access public
	 */
	rotateControl(controlId: string, direction: boolean, deviceId: string | undefined): boolean {
		const control = this.getControl(controlId)
		if (control && typeof control.rotateControl === 'function') {
			control.rotateControl(direction, deviceId)
			return true
		}

		return false
	}

	/**
	 * Rename an instance for variables used in the controls
	 * @param {string} fromlabel - the old instance short name
	 * @param {string} tolabel - the new instance short name
	 * @access public
	 */
	renameVariables(labelFrom: string, labelTo: string): void {
		for (const control of Object.values(this.#controls)) {
			if (control && typeof control.renameVariables === 'function') {
				control.renameVariables(labelFrom, labelTo)
			}
		}
	}

	/**
	 * Reset all controls
	 * @access public
	 */
	resetAllControls() {
		for (const controlId of Object.keys(this.#controls)) {
			this.resetControl(controlId, undefined)
		}
	}

	/**
	 * Reset/reinitialise a control
	 * @param {string} controlId The id of the control to reset
	 * @param {string | undefined} newType The type of the new control to create (if any)
	 * @returns {boolean} success
	 * @access public
	 */
	resetControl(controlId: string, newType?: string): boolean {
		const control = this.getControl(controlId)
		if (control) {
			control.destroy()
			delete this.#controls[controlId]

			this.db.setKey(['controls', controlId], undefined)
		}

		if (!this.#validateBankControlId(controlId)) {
			// Control id is not valid!
			return false
		}

		// Notify interested parties
		const parsedId = ParseControlId(controlId)
		if (parsedId?.type === 'bank') {
			this.services.emberplus.updateBankState(parsedId.page, parsedId.bank, false, undefined)
		}

		if (newType) {
			// Initialise to new type
			this.#controls[controlId] = this.#createClassForControl(controlId, 'bank', newType, null, false) ?? undefined
		} else {
			// Force a redraw
			this.graphics.invalidateControl(controlId)
		}

		return true
	}

	/**
	 * Update values for some feedbacks
	 * @param {string} instanceId
	 * @param {object} result - object containing new values for the feedbacks that have changed
	 * @access public
	 */
	updateFeedbackValues(instanceId: string, result): void {
		const values: Record<string, Record<string, boolean | CompanionAdvancedFeedbackResult> | undefined> = {}

		for (const item of result) {
			const objForControl = values[item.controlId] || {}
			values[item.controlId] = objForControl

			objForControl[item.id] = item.value
		}

		// Pass values to controls
		for (const [controlId, newValues] of Object.entries(values)) {
			const control = this.getControl(controlId)
			if (control && control.feedbacks && newValues && typeof control.feedbacks.updateFeedbackValues === 'function') {
				control.feedbacks.updateFeedbackValues(instanceId, newValues)
			}
		}
	}

	/**
	 * Verify a controlId is valid for the current id scheme and grid size
	 * @param {string} controlId
	 * @returns {boolean} control is valid
	 * @access private
	 */
	#validateBankControlId(controlId: string): boolean {
		const parsed = ParseControlId(controlId)
		if (parsed?.type !== 'bank') return false
		if (parsed.page < 1 || parsed.page > 99) return false
		if (parsed.bank < 1 || parsed.bank > MAX_BUTTONS) return false

		return true
	}

	/**
	 * Verify a controlId is valid for the current id scheme and grid size
	 * @param {string} controlId
	 * @returns {boolean} control is valid
	 * @access private
	 */
	#validateTriggerControlId(controlId: string): boolean {
		const parsed = ParseControlId(controlId)
		if (parsed?.type !== 'trigger') return false

		return true
	}

	/**
	 * Prune any items on controls which belong to an unknown instanceId
	 * @access public
	 */
	verifyInstanceIds(): void {
		const knownInstanceIds = new Set<string>(this.instance.getAllInstanceIds())
		knownInstanceIds.add('internal')

		for (const control of Object.values(this.#controls)) {
			if (control && typeof control.verifyInstanceIds === 'function') {
				control.verifyInstanceIds(knownInstanceIds)
			}
		}
	}
}

export default ControlsController
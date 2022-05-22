import CoreBase from '../Core/Base.js'

export default class ActionRunner extends CoreBase {
	/**
	 * Timers for all pending delayed actions
	 * @access protected
	 */
	timers_running = new Map()

	constructor(registry) {
		super(registry, 'action-runner', 'Control/ActionRuner')
	}

	/**
	 * Abort all pending delayed actions
	 */
	abortAllDelayed() {
		this.logger.silly('Aborting delayed actions')

		const affectedControlIds = new Set()

		// Clear the timers
		for (const [timer, controlId] of this.timers_running.entries()) {
			clearTimeout(timer)
			affectedControlIds.add(controlId)
		}
		this.timers_running.clear()

		// Redraw any controls
		for (const controlId of affectedControlIds.values()) {
			this.#setControlIsRunning(controlId, false)
		}
	}

	/**
	 * Abort pending delayed actions for a control
	 * @param {string} controlId Id of the control
	 * @param {boolean} skip_up Mark button as released
	 */
	abortControlDelayed(controlId, skip_up) {
		// Clear any timers
		let cleared = false
		for (const [timer, timerControlId] of this.timers_running.entries()) {
			if (timerControlId === controlId) {
				if (!cleared) {
					this.logger.silly('Aborting button ', page, ',', bank)
					cleared = true
				}

				this.timers_running.delete(timer)
				clearTimeout(timer)
			}
		}

		// Update control
		this.#setControlIsRunning(controlId, false, skip_up)
	}

	/**
	 * Run a single action
	 * @param {*} action
	 * @param {*} extras
	 */
	#runAction(action, extras) {
		if (action.instance === 'internal') {
			this.internalModule.executeAction(action, extras)
		} else {
			const instance = this.instance.moduleHost.getChild(action.instance)
			if (instance) {
				instance.actionRun(action, extras).catch((e) => {
					this.logger.silly(`Error executing action for ${instance.connectionId}: ${e.message}`)
					this.registry.log.add(`instance(${instance.connectionId})`, 'warn', 'Error executing action: ' + e.message)
				})
			} else {
				this.logger.silly('trying to run action on a missing instance.', action)
			}
		}
	}

	#setControlIsRunning(controlId, running, skip_up) {
		const control = this.controls.getControl(controlId)
		if (control && typeof control.setActionsRunning === 'function') {
			control.setActionsRunning(running, skip_up)
		}
	}

	/**
	 * Run multiple actions
	 * @param {Array<object>} actions
	 * @param {string} controlId
	 * @param {boolean} relative_delay
	 * @param {*} extras
	 */
	runMultipleActions(actions, controlId, relative_delay, extra) {
		// Handle whether the delays are absolute or relative.
		const effective_delays = {}
		let tmp_delay = 0
		for (const action of actions) {
			let this_delay = !action.delay ? 0 : parseInt(action.delay)
			if (isNaN(this_delay)) this_delay = 0

			if (relative_delay) {
				// Relative delay: each action's delay adds to the next.
				tmp_delay += this_delay
			} else {
				// Absolute delay: each delay is its own.
				tmp_delay = this_delay
			}

			// Create the property .effective_delay. Don't change the user's .delay property.
			effective_delays[action.id] = tmp_delay
		}

		let has_delayed = false
		for (const action of actions) {
			const delay_time = effective_delays[action.id] === undefined ? 0 : effective_delays[action.id]

			this.logger.silly('Running action', action)

			// is this a timedelayed action?
			if (delay_time > 0) {
				has_delayed = true
				const timer = setTimeout(() => {
					this.#runAction(action, extra)

					this.timers_running.delete(timer)

					// Stop timer-indication
					const hasAnotherTimer = Array.from(this.timers_running.values()).find((v) => v === controlId)
					if (hasAnotherTimer === undefined) {
						this.#setControlIsRunning(controlId, false)
					}
				}, delay_time)

				this.timers_running.set(timer, controlId)
			}

			// or is it immediate
			else {
				this.#runAction(action, extra)
			}
		}

		if (has_delayed) {
			// Start timer-indication
			this.#setControlIsRunning(controlId, true)
		}
	}
}
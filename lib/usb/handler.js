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

/*
	This is written with the idea that it might only handle one device, or more than one device
	for future compatibility. Currently each handler instance only handles one device though.
*/

if (process.env.COMPANION_USE_HIDRAW && process.platform === 'linux') {
	var HID = require('node-hid')
	HID.setDriverType('hidraw')
	// Force it to load just in case
	HID.devices()
}

var drivers = {
	elgato: require('./elgato'),
	'elgato-v2': require('./elgato'),
	'elgato-mini': require('./elgato-mini'),
	'elgato-xl': require('./elgato-xl'),
	'elgato-pedal': require('./elgato-pedal'),
	'elgato-plus': require('./elgato-plus'),
	infinitton: require('./infinitton'),
	xkeys: require('./xkeys'),
	'loupedeck-live': require('./loupedeck-live'),
	'loupedeck-live-s': require('./loupedeck-live-s'),
}

global.MAX_BUTTONS = parseInt(process.env.MAX_BUTTONS)
global.MAX_BUTTONS_PER_ROW = parseInt(process.env.MAX_BUTTONS_PER_ROW)

var EventEmitter = require('events').EventEmitter
var util = require('util')
var driver_instances = {}

function eventhandler() {
	EventEmitter.call(this)
}
util.inherits(eventhandler, EventEmitter)

eventhandler.prototype.emit = function () {
	var args = [].slice.call(arguments)
	process.send({ cmd: 'system', args: args })
	EventEmitter.prototype.emit.apply(this, args)
}

var system = new eventhandler()

process.on('message', function (data) {
	if (data.cmd == 'add') {
		try {
			var type = drivers[data.type]
			driver_instances[data.id] = new type(system, data.devicepath)
			driver_instances[data.id].log = function () {
				var args = [].slice.call(arguments)
				process.send({ cmd: 'debug', id: data.id, args: args })
			}

			if (driver_instances[data.id].info.serialnumber) {
				process.send({ cmd: 'add', id: data.id, info: driver_instances[data.id].info })
			} else {
				driver_instances[data.id].finish_add = function () {
					process.send({ cmd: 'add', id: data.id, info: driver_instances[data.id].info })
				}
			}
		} catch (e) {
			process.send({ cmd: 'error', id: data.id, error: e.message + ' AND GOT: ' + JSON.stringify(data) })
		}
	} else if (data.cmd == 'execute') {
		try {
			var result = driver_instances[data.id][data.function].apply(driver_instances[data.id], data.args)
			if (data.returnId !== undefined) {
				process.send({ cmd: 'return', id: data.id, returnId: data.returnId, result: result })
			}
		} catch (e) {
			process.send({ cmd: 'error', id: data.id, error: e.message })
		}
	} else if (data.cmd == 'system') {
		EventEmitter.prototype.emit.apply(system, data.args)
	} else if (data.cmd == 'remove') {
		try {
			driver_instances[data.id].quit()
			process.send({ cmd: 'remove', id: data.id })
		} catch (e) {
			process.send({ cmd: 'error', id: data.id, error: e.message })
		}
	}
})

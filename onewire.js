import { readdirSync } from 'fs';
import { EventEmitter } from 'events';
import _ from 'lodash';
import { exec } from 'child_process';

import owfs from 'owfs';

//const W1_PATH = '/sys/bus/w1/devices/';

export default class OneWire
{
	constructor()
	{
		this.event 			= new EventEmitter();
		this.checkDevices 	= this.checkDevices.bind(this); // bind 'this' to the method
		
		
		this.owfs_client 	= new owfs.Client('127.0.0.1', 4304);
		this.known_devices 	= new Set();
		this.scanning		= false;
		
		console.log('Starting iButton reader');
		
		setInterval(this.checkDevices, 500);
	}
	
	checkDevices()
	{
		if(this.scanning)
			return; // already busy, please wait
		
		this.scanning = true;
		
		try {
			this.owfs_client.dir('/', (err, devices) => {
				
				this.scanning = false;
				
				if (err) {
					console.log('OWFS error:', err);
					return;
				}

				const newDevices = devices.filter(d => !this.known_devices.has(d));
				const removedDevices = Array.from(this.known_devices).filter(d => !devices.includes(d));

				newDevices.forEach(device_id => {
					console.log('🔵 iButton connected:', device_id);
					this.known_devices.add(device_id);
					
					console.log(device_id);
					
					// /33.15FC29050000 = DJO iButton
					if(device_id != '/33.15FC29050000')
					{
						console.log('not djo button');
						this.event.emit('device-found', device_id);
					}
				});

				removedDevices.forEach(d => {
					console.log('🔴 iButton removed:', d);
					this.known_devices.delete(d);
				});
			});
			
			/*
			const entries = readdirSync(W1_PATH);
			// Filter out the master controller
			// 33-00000529fc15 = DJO iButton
			const devices = entries.filter(entry => entry !== 'w1_bus_master1' && !entry.startsWith('00-') && entry != "33-00000529fc15");
			
			_.each(devices, (device_id) => {
				
				const cmd = `echo "${device_id}" | sudo tee /sys/bus/w1/devices/w1_bus_master1/w1_master_remove`;
				
				exec(cmd, (error, stdout, stderr) =>
				{
					if (error)
					{
						console.error(`Failed to remove device ${device_id}:`, error.message);
						return;
					}
					if (stderr)
					{
						console.error(`stderr while removing device ${device_id}:`, stderr);
						return;
					}

					console.log(`Device ${device_id} removed successfully.`);
				});
				
				this.event.emit('device-found', device_id);
			});
			*/
		} catch (err) {
			console.error('Error reading 1-Wire devices:', err.message);
		}
	}
}
import net from 'net';
import { EventEmitter } from 'events';

export default class OneWire
{
	constructor()
	{
		this.event = new EventEmitter();
		this.known_devices = new Set();
		
		console.log('Starting iButton reader');
		
		this.server = net.createServer((socket) => {
			console.log('Client connected');

			socket.on('data', (data) => {
				console.log('iButton ROM received:', data.toString());
				const device_id = data.toString();
				
				if(!this.known_devices.has(device_id))
					this.addDevice(device_id);
			});

			socket.on('end', () => {
				console.log('Client disconnected');
			});
		});

		this.server.listen(5000, '127.0.0.1', () => {
			console.log('Server listening on port 5000');
		});
	}
	
	addDevice(device_id)
	{
		console.log('🔵 iButton connected:', device_id);
		this.known_devices.add(device_id);
		
		// reset after 1 seconds
		setTimeout(() => {
			this.removeDevice(device_id);
		}, 1000)
		
		// Skip DJO iButton
		if (device_id !== '3315FC29050000B2') 
			this.event.emit('device-found', device_id);  
	}

	removeDevice(device_id)
	{
		console.log('🔴 iButton removed:', device_id);
		this.known_devices.delete(device_id);
		this.event.emit('device-removed', device_id);
	}
}
// define a printer connection
import mqtt from 'mqtt';
import _ from 'lodash';
import moment from 'moment';
import http from 'http';
import { Client as FTPClient } from "basic-ftp";
import { promises as fs } from 'fs';
import { Server as SocketServer } from 'socket.io';
import path from 'path';
import unzipper from 'unzipper';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import Config from './config.js'; 
import { time_to_minutes, is_empty } from './utils.js';

import BitlairBank from './ssh.js';
import OneWire from './onewire.js';
        
// disable self cert
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0; 

const CLIENT_ID 					= 'nodejs-client-' + Math.random().toString(16).substr(2, 8);
const TIME_BETWEEN_COMMANDS_MS 		= 100;
const BITLAIR_BANK 					= new BitlairBank();
const IBUTTON_READER 				= new OneWire();
const USE_DUMMY_DATA				= false;
const PROCESSING_TIMEOUT_SECONDS	= 300; // 5 min

console.log("Starting", isWithinDjoTime() ? " DJO tijd" : "bitlair tijd");

const PRINTERS = _.cloneDeep(Config.PRINTERS);

// Get the current directory path in ES modules
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const serveStaticFile = (filePath, res) => {
    fs.readFile(filePath)
        .then((data) => {
            const ext = path.extname(filePath);
            let contentType = 'text/plain';

            if (ext === '.html') contentType = 'text/html';
            else if (ext === '.js') contentType = 'application/javascript';
            else if (ext === '.css') contentType = 'text/css';
            else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
            else if (ext === '.png') contentType = 'image/png';
            else if (ext === '.gif') contentType = 'image/gif';

            res.setHeader('Content-Type', contentType);
            res.end(data);
        })
        .catch((err) => {
            console.error('Error reading file:', err); // Log the error
            res.statusCode = 404;
            res.end('File not found');
        });
};

/*readPrinterFile('./latest_print_3.gcode.3mf').then((gcode_response) => {   
	console.log('gcode_response', gcode_response);                              
})*/ 



const http_server = http.createServer(function (req, res) {
    // Enable CORS for all origins (or restrict to your frontend URL)
    res.setHeader('Access-Control-Allow-Origin', '*'); // or 'http://192.168.2.34:3000'
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight request
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
	     
	// Normalize the request URL
    const requestPath = req.url === '/' ? '/index.html' : req.url;

    let filePath;
	
	console.log('requestPath', requestPath);
	
    if (requestPath.endsWith('.3mf')) {
        // Serve 3MF files from ../Print-manager/
        const fileName = path.basename(requestPath); // extract just the filename
        filePath = path.join(__dirname, '..', 'Print-manager', fileName);
    } else {
        // Serve other files from public folder
        filePath = path.join(__dirname, 'public', requestPath);
    }

    // Serve the requested file (or 404 if it doesn't exist)
    serveStaticFile(filePath, res);  
});//.listen(8080); //the server object listens on port 8080

const io = new SocketServer(http_server, {
    cors: {
        origin: '*', // React dev server
        methods: ['GET', 'POST']
    }
});


/*
last_authenticated_user = {id: 0, username: 'DJO'};
			
socket.emit('user authenticated', 'DJO');
*/


let socket_selected_printer_serials = {};
let last_authenticated_user = undefined;

io.on('connection', socket => {
	
    console.log('a user connected:', socket.id);
	
	socket_selected_printer_serials[socket.id] = undefined;
	
	IBUTTON_READER.event.on('device-found', (device_id) => {
		if(isWithinDjoTime())
		{
			last_authenticated_user = {id: device_id, username: 'DJO'};
			socket.emit('user authenticated', 'DJO');
		}
		else
		{
			//last_authenticated_user = {id: device_id, username: '-1'};
			socket.emit('user authenticated', '-1');
		}
	});
	
    socket.on('message', data => {
        console.log('Message received:', data);
        // socket.broadcast.emit('message', data);
    });

	socket.on('select printer', (printer_serial) => {
		socket_selected_printer_serials[socket.id] = printer_serial;
	});

	socket.on('deselect printer', () => {
		if(socket_selected_printer_serials[socket.id])
		{
			socket_selected_printer_serials[socket.id] = undefined;
			
			console.log('socket deselect printer', last_authenticated_user);  
			
			// resetten regardless so someone can't abuse it
			last_authenticated_user = undefined;
		}
	});
	
	socket.on('accept print', (auto_payment) => {
		console.log('socket: accept print', auto_payment, last_authenticated_user, socket_selected_printer_serials[socket.id]);
		// no authenticated user found or selected printer for this socket, why is it even sending this event?
		if(is_empty(last_authenticated_user) || is_empty(socket_selected_printer_serials[socket.id]))
			return;
		
		const printer = _.find(PRINTERS, printer => printer.serial == socket_selected_printer_serials[socket.id]);
		
		if(printer && printer.last_print)
		{
			printer.last_accepted_md5 		= printer.last_print.md5;
			printer.last_accepted_by_user 	= last_authenticated_user;
			printer.auto_payment			= auto_payment || false;
			
			// resetten, they performed the action they authenticated for
			last_authenticated_user = undefined;
			
			if(isWithinDjoTime)
				sendResumeCommand(printer.mqtt_client, printer.serial); 
			
			updateClientPrinterData();
		}
	});
	
	// push latest info to the new client
	updateClientPrinterData(socket);
	
	socket.emit('update djo time minutes', Config.DJO_TIME_MINUTES);

    socket.on('disconnect', () => {
        console.log('user disconnected:', socket.id);

		delete socket_selected_printer_serials[socket.id];
    });
});

http_server.listen(4000, '0.0.0.0', () => {
    console.log('Listening on all interfaces at port 4000');
});






function getFtpClient(printer)
{
	try {
		// ftp_client.ftp.verbose = true;
		const ftp_client 		= new FTPClient();
		const access_response 	= ftp_client.access({
			host: 		printer.ip,
			port: 		990,
			user: 		printer.username,
			password: 	printer.password,
			secure: 	'implicit',
		}).catch(err =>
			console.log('Caught async FTP error:', err.message)
		);
		
		return new Promise((resolve, reject) => {
			access_response.then(() => {
				resolve(ftp_client);
			})
		});
	}
	catch(exception)
	{
		console.log('FTP failed for printer ', printer.title, ' with exception ', exception);
	}
}

_.each(PRINTERS, (printer, printer_index) => {
	let total_payload = {};
	let initialized = false;
	let refresh_requested = false;
	let processing_new_print_timeout = undefined;
	let last_task_id = undefined;
	
	printer.processing_new_print = false;
	printer.last_accepted_md5 = undefined;

	// MQTT connection options for Bambu printer
	const options = {
		clientId: CLIENT_ID,
		username: printer.username,
		password: printer.password,
		protocol: 'mqtts',
		rejectUnauthorized: false // Accept self-signed certs (for dev only)
	};

	const slowedUpdateClientPrinterData = _.throttle(updateClientPrinterData, 2000);

	if(USE_DUMMY_DATA)
	{
		if(!printer.gcode_information)
			readPrinterFile('./latest_print_' + printer_index + '.gcode.3mf').then((data) => {
				
				printer.gcode_information 			= data;
				printer.gcode_information.last_file = "test";
				printer.last_print 					= {title: data.filename};
				
				slowedUpdateClientPrinterData();                    
			});
		printer.last_print = {title: 'test.png'}
		printer.state = 'RUNNING';
	}
	
	try {
		// Connect to the printer's MQTT broker
		printer.mqtt_client = mqtt.connect(`mqtts://${printer.ip}:8883`, options);

		printer.mqtt_client.on('connect', () => {
			console.log('✅ Connected to printer MQTT!');

			const topic = `device/${printer.serial}/report`; // This is the standard topic

			printer.mqtt_client.subscribe(topic, (err) => {
				if (err) {
					console.error('❌ Subscription error:', err.message);
				} else {
					console.log(`📡 Subscribed to topic: ${topic}`);
				}
			});
			
			sendRefreshCommand(printer.mqtt_client, printer.serial).then(() => {
				refresh_requested = true;
			});
		});

		printer.mqtt_client.on('message', (topic, message) => {
			try {
				const payload = JSON.parse(message.toString()); 
				
				//payload comes in with only changes every time, not the full payload
				total_payload = _.merge(total_payload, payload);
				
				if(isWithinDjoTime())
				{
					// lets see if we need to pause the print bc someone uploaded it without approval
					if (total_payload.print.md5) {
						if(printer.last_accepted_md5 != total_payload.print.md5 && total_payload.print.gcode_state == "RUNNING")
						{
							sendPauseCommand(printer.mqtt_client, printer.serial);
							console.log('NOT CONFIRMED PRINT, pausing print: ', total_payload.print.md5);
						}
					}

					// someone tried to modify the speed again... lets deny this
					if (total_payload.print.spd_lvl && total_payload.print.spd_lvl > 2)
						sendSpeedCommand(printer.mqtt_client, printer.serial, 2);
				}
				
				if(printer.auto_payment && printer.gcode_information && printer.gcode_information.weight > 0)
				{
					if(
						total_payload.print.gcode_state == "FINISH" && 
						printer.last_accepted_md5 == total_payload.print.md5 && 
						printer.last_paid_for_md5 != total_payload.print.md5
					)
					{
						BITLAIR_BANK.pay3DPrint(_.round(printer.gcode_information.weight), printer.last_accepted_by_user.username.toLowerCase()); 
						console.log('Paid for the weight of ' + printer.gcode_information.weight + ' for the user ' + printer.last_accepted_by_user);
						
						printer.last_paid_for_md5 = total_payload.print.md5;
						
						fs.appendFile('printer_paid_log.log', getDateAndTime() + 'Paid for the weight of ' + printer.gcode_information.weight + ' for the user ' + printer.last_accepted_by_user.username + ' (' + printer.last_accepted_by_user.id + ') \n\n\n', 'utf8', (err) => {
							if (err) {
								console.error('Error appending to file:', err);
							} else {
								console.log('Data has been appended to the file');
							}
						});
					}
				}
				
				// todo check when a new print is executed
				if(
					(total_payload.print.gcode_state == "FINISH" || total_payload.print.gcode_state == "RUNNING" || !initialized) &&
					(
						!printer.gcode_information ||
						(
							printer.gcode_information.last_file != total_payload.print.file && 
							printer.gcode_information.last_file != total_payload.print.subtask_name
						) ||
						(initialized && total_payload.print.task_id != last_task_id) // also refresh if the task_id has changed
					)
				) {  
					if(total_payload.print.subtask_name)
					{
						const local_filename = './latest_print_' + printer_index + '.gcode.3mf';
						
						printer.gcode_information = {
							last_file: total_payload.print.subtask_name
						};
						
						try {
							getFtpClient(printer).then((ftp_client) => {
								ftp_client.list().then((files) => {
									// Find the file that matches the pattern
									const matchedFile = files.find(file => {
										if(file.name.startsWith('Bench'))
											console.log(file.name.toLowerCase(), total_payload.print.subtask_name.toLowerCase(), total_payload.print.subtask_name.replace(/\s+/g, '_').toLowerCase());
										
										return file.name.toLowerCase().includes(total_payload.print.subtask_name.toLowerCase()) || file.name.toLowerCase().includes(total_payload.print.subtask_name.replace(/\s+/g, '_').toLowerCase())
									})
									
									if (matchedFile)
									{
										printer.processing_new_print = true;
										slowedUpdateClientPrinterData();
										
										if(processing_new_print_timeout)
											clearTimeout(processing_new_print_timeout);
										
										// timeout just in case there is any failure or it just takes ages for very complex prints
										processing_new_print_timeout = setTimeout(() => {
											printer.processing_new_print = false;
											processing_new_print_timeout = undefined;
											slowedUpdateClientPrinterData();
											console.log('Processing timeout reached for printer ', printer.title);
										}, PROCESSING_TIMEOUT_SECONDS * 1000);
										
										try {
											ftp_client.downloadTo(local_filename, matchedFile.name).then(() => {
												console.log('File downloaded for printer ', printer.title);
												
												readPrinterFile(local_filename).then(data => {
													if(data.status)
													{
														printer.gcode_information 			= data;
														printer.gcode_information.last_file = total_payload.print.subtask_name;
													}
													
													if(processing_new_print_timeout)
														clearTimeout(processing_new_print_timeout);
													
													printer.processing_new_print = false;
													processing_new_print_timeout = undefined;
													slowedUpdateClientPrinterData();
													
													console.log('Parsed data from worker:', data);
												})
												.catch(err => {
													console.error('Worker error:', err);
													printer.gcode_information = undefined;
													last_task_id = undefined;
													slowedUpdateClientPrinterData();
												});
												
												ftp_client.close();
											}).catch((exception) => {
												console.log('FTP downloadTo failed', exception);
												printer.gcode_information = undefined;
												last_task_id = undefined;
												slowedUpdateClientPrinterData();
												
												ftp_client.close();
											});
										}
										catch (exception)
										{
											console.log('FTP downlaod to failed', exception);
											printer.gcode_information = undefined;
											last_task_id = undefined;
											slowedUpdateClientPrinterData();
											
											ftp_client.close();
										}
									}
								});
							})
						} catch(exception)
						{
							console.log('FTP list failed', exception);
							printer.gcode_information = undefined;
							last_task_id = undefined; 
							slowedUpdateClientPrinterData();
						}
					}
				}
				
				printer.total_payload = total_payload;
				// update printer information
				printer.state 					= total_payload.print.gcode_state || 'IDLE';
				printer.remaining_time_min 		= total_payload.print.mc_remaining_time;
				printer.remaining_percentage	= total_payload.print.mc_percent;
				printer.last_print = {
					md5:	total_payload.print.md5,
					file:	total_payload.print.gcode_file,
				};
				
				if(total_payload.print.subtask_name);
					printer.last_print.title = total_payload.print.subtask_name;
				
				last_task_id = total_payload.print.task_id;
				
				slowedUpdateClientPrinterData();
				
				// set initialized so we know this is the refreshed data
				if(!initialized && refresh_requested)
					initialized = true;
			} catch (err) {
				console.log('MQTT message error: ', err);
			}
		});

		printer.mqtt_client.on("printer:statusUpdate", (oldStatus, newStatus) => {
			console.log(`The printer's status has changed from ${oldStatus} to ${newStatus}!`)
		});
		printer.mqtt_client.on("job:update", () => {
			console.log("job:update", arguments);
		});
		printer.mqtt_client.on("job:start", () => {
			console.log("job:start", arguments);
		});
		printer.mqtt_client.on("job:pause", () => {
			console.log("job:pause", arguments);
		});
		printer.mqtt_client.on("job:offlineRecovery", () => {
			console.log("job:offlineRecovery", arguments);
		});
		printer.mqtt_client.on("job:unpause", () => {
			console.log("job:unpause", arguments);
		});
		printer.mqtt_client.on("job:finish", () => {
			console.log("job:finish", arguments);
		});
		printer.mqtt_client.on('error', (err) => {
			console.error('❌ MQTT Error:', err.message);
		});
	} catch(exception) {
		console.log('failed to create mqtt client: ', printer);
	}
});

function sendGcodeCommand(mqtt_client, serial, gcodeCommand) {
	sendCommand(mqtt_client, serial, "gcode_line", gcodeCommand);
}

function sendPauseCommand(mqtt_client, serial) {
	sendCommand(mqtt_client, serial, "pause", "");
}

function sendResumeCommand(mqtt_client, serial) {
	sendCommand(mqtt_client, serial, "resume", "");
}

function sendSpeedCommand(mqtt_client, serial, speed) {
	sendCommand(mqtt_client, serial, "print_speed", "" + speed + "");
}

function sendCommand(mqtt_client, serial, command, params) {
	const current_ts = moment().format('x');

	// this prevent it from spamming commands every ms
	if (mqtt_client.last_command_ts && current_ts < parseInt(mqtt_client.last_command_ts) + TIME_BETWEEN_COMMANDS_MS)
		return;

	mqtt_client.last_command_ts = current_ts;

	const topic = `device/${serial}/request`;  // This is typically the topic for G-code commands

	// Publish the G-code command to the printer
	mqtt_client.publish(topic, JSON.stringify({
		"print": {
			"sequence_id": "0",
			"command": command,
			"param": params, // Gcode to execute, can use \n for multiple lines
			"user_id": "" // Optional
		}
	}), (err) => {
		if (err) {
			console.error('❌ Failed to send command:', err, command, params);
		} else {
			console.log(`✅ Sent command: ${command} - ${params}`);
		}
	});
}

/*function sendRefreshCommand(mqtt_client, serial)
{
	const topic = `device/${serial}/request`;  // This is typically the topic for G-code commands

	// Publish the G-code command to the printer
	mqtt_client.publish(topic, JSON.stringify({
		"pushing": {
			"sequence_id": "0",
			"command": "pushall",
			"version": 1,
			"push_target": 1
		}
	}), (err) => {
		if (err) {
			console.error('❌ Failed to send REFRESH command:', err);
		} else {
			console.log(`✅ Sent command: REFRESH`);
		}
	});
}*/

function sendRefreshCommand(mqtt_client, serial)
{
	return new Promise((resolve, reject) => {
		const topic = `device/${serial}/request`;

		const payload = JSON.stringify({
			"pushing": {
				"sequence_id": "0",
				"command": "pushall",
				"version": 1,
				"push_target": 1
			}
		});

		mqtt_client.publish(topic, payload, (err) => {
			if (err) {
				console.error('❌ Failed to send REFRESH command:', err);
				reject(err);
			} else {
				console.log(`✅ Sent command: REFRESH`);
				resolve();
			}
		});
	});
}

function getDateAndTime() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

/*
function getGcodeInformationFromContent(content)
{
	const lines = content.split('\n');
	const response = {weight: 0, estimated_time: 0};
	
	let time_found = false;
	let weight_found = false;
	
	_.each(lines, (line) => {
		if(line.includes('total estimated time'))
		{
			const time_in_text = line.split('total estimated time: ')[1];
			
			response.estimated_time = convertToSeconds(time_in_text);
			
			time_found = true;
		}
		
		if(line.includes('weight'))
		{
			const weight_in_text = line.split(':')[1]; 
			
			response.weight = sumWeightValues(weight_in_text);
			
			weight_found = true;
		}
		
		// found both data already, no need to continue to read all lines
		if(time_found && weight_found)
			return false; // break;
	});
	
	if(response.weight <= 1 && response.estimated_time > 0)
		response.weight = 1;
	
	return response;
}

function convertToSeconds(timeString) {
  const regex = /(\d+)h\s*(\d+)m\s*(\d+)s|(\d+)m\s*(\d+)s|(\d+)s/;
  const match = timeString.trim().match(regex);

  if (match) {
    let totalSeconds = 0;

    if (match[1] && match[2] && match[3]) {  // "Xh Ym Zs" format
      const hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const seconds = parseInt(match[3], 10);
      totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
    } else if (match[4] && match[5]) {  // "Ym Zs" format
      const minutes = parseInt(match[4], 10);
      const seconds = parseInt(match[5], 10);
      totalSeconds = (minutes * 60) + seconds;
    } else if (match[6]) {  // "Xs" format
      const seconds = parseInt(match[6], 10);
      totalSeconds = seconds;
    }

    return totalSeconds;
  } else {
    throw new Error("Invalid time format. Expected 'Xh Ym Zs', 'Ym Zs', or 'Xs'.");
  }
}

function sumWeightValues(valueString) {
  // Split the string by commas and parse the individual numbers
  const values = valueString.split(',').map(value => parseFloat(value.trim()));

  // Sum all the parsed values
  return values.reduce((sum, value) => sum + value, 0).toFixed(2);
}
*/


// code to go through the whole gcode and calculate weight and time based on it
/*
function getGcodeInformation(filePath) {
    return fs.readFile(filePath, 'utf8').then((gcode) => {
        const lines = gcode.split('\n');
  
        let totalExtruded = 0;
        let isRelativeMode = false;
		let lastE = null; // Add this at the top

        let lastX = null, lastY = null, lastZ = null, lastF = 1500;
        let prevX = null, prevY = null, prevZ = null;
        let totalTimeSeconds = 0;

        let loadTime = 0;
        let unloadTime = 0;
        let toolChanges = 0;
        let currentTool = null;

        for (let line of lines) {

            if (line.startsWith(';')) {
                // Parse machine config times
                const loadMatch = line.match(/machine_load_filament_time\s*=\s*(\d+)/);
                const unloadMatch = line.match(/machine_unload_filament_time\s*=\s*(\d+)/);

                if (loadMatch)
					loadTime = parseInt(loadMatch[1]);

                if (unloadMatch)
					unloadTime = parseInt(unloadMatch[1]);

                continue;
            }

            if (!line.trim())
				continue;

            // Detect extrusion mode
            if (line.includes('M83'))
				isRelativeMode = true;
            else if (line.includes('M82'))
				isRelativeMode = false;

            // Detect tool change
            const toolMatch = line.match(/^T(\d+)/);
            if (toolMatch) {
                const tool = parseInt(toolMatch[1]);

                if (tool !== currentTool) {
                    currentTool = tool;
                    toolChanges++;
                }
            }

			const isMovement = /^G[0-3]/.test(line);

            if (isMovement) {
                const x = parseFloat((line.match(/\sX([-\d.]+)/) || [])[1]);
                const y = parseFloat((line.match(/\sY([-\d.]+)/) || [])[1]);
                const z = parseFloat((line.match(/\sZ([-\d.]+)/) || [])[1]);
                const f = parseFloat((line.match(/\sF([-\d.]+)/) || [])[1]);

                // Update previous position before overwriting
                prevX = lastX;
                prevY = lastY;
                prevZ = lastZ;

                if (!Number.isNaN(x)) lastX = x;
                if (!Number.isNaN(y)) lastY = y;
                if (!Number.isNaN(z)) lastZ = z;
                if (!Number.isNaN(f)) lastF = f;

                // Estimate time only when we have at least previous and current coords
                if (
                    prevX !== null && prevY !== null && prevZ !== null &&
                    lastX !== null && lastY !== null && lastZ !== null &&
                    lastF !== null
                ) {
                    const dx = lastX - prevX;
                    const dy = lastY - prevY;
                    const dz = lastZ - prevZ;
                    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    totalTimeSeconds += (distance / lastF) * 60;
                }
            }

            // Match G0/G1/G2/G3 lines with E values
            const match = line.match(/^G(?:0|1|2|3)[^;]*\sE([\-]?\d*\.?\d+)/);

            if (match) {
                const eVal = parseFloat(match[1]);

                if (isRelativeMode) {
					
					if (!Number.isNaN(eVal) && lastF)
						totalTimeSeconds += (eVal / lastF) * 60;

                    totalExtruded += eVal;
                } else {
					if (lastE !== null && !Number.isNaN(eVal)) {
						const delta = eVal - lastE;

						if (delta > 0)
						{
							if (lastF)
								totalTimeSeconds += (delta / lastF) * 60;

							totalExtruded += delta; // Only count forward moves
						}
					}
					lastE = eVal;
                }
            }
        }
		
        const filamentDiameter = 1.75;
        const filamentDensity = 1.25;
        const radius = filamentDiameter / 2;
		const volumeMm3 = Math.PI * Math.pow(radius, 2) * totalExtruded; // in mm3
		const volumeCm3 = volumeMm3 / 1000;
        const weightGrams = volumeCm3 * filamentDensity;

        // Add color change time
        totalTimeSeconds += toolChanges * (loadTime + unloadTime);
		totalTimeSeconds += 360;// startup time

        return {
            length: parseFloat(totalExtruded.toFixed(2)),
            weight: parseFloat(weightGrams.toFixed(2)),
			estimated_time: _.ceil(totalTimeSeconds),
        };
    });
}
*/

function updateClientPrinterData(socket = undefined)
{
	let printers = _.cloneDeep(PRINTERS);

	_.each(printers, (printer) => {
		// printer = _.omit(printer, ['ip', 'username', 'password']); //strip the ip,username and password from the return values
		delete printer.ip;
		delete printer.username;
		delete printer.password;
		delete printer.total_payload;
		delete printer.mqtt_client;
	});
	
	if(socket)
		socket.emit('update printer data', printers);
	else
		io.emit('update printer data', printers);
	
	/*
	// file needs the state of the files
	printers = _.cloneDeep(PRINTERS);

	_.each(printers, (printer) => {
		// printer = _.omit(printer, ['ip', 'username', 'password']); //strip the ip,username and password from the return values
		delete printer.ip;
		delete printer.username;
		delete printer.password;
		delete printer.mqtt_client; // not required
		
	});

	fs.appendFile('printer_data_logs.log', JSON.stringify(printers) + '\n\n\n', 'utf8', (err) => {
		if (err) {
			console.error('Error appending to file:', err);
		} else {
			console.log('Data has been appended to the file');
		}
	});
	*/
}

/*function extractPlateGcode(filePath)
{
	console.log('extractPlateGcode', filePath);
	
    return unzipper.Open.file(filePath).then((directory) => {
		const file = directory.files.find(file =>
			file.path.startsWith('Metadata/plate_') && file.path.endsWith('.gcode')
		);

		if (!file)
			throw new Error('plate_1.gcodd not found')
		
		return file.buffer();
	}).then((content) => {
		return content.toString('utf8');
	});
}*/

// lets keep track of the amount of workers
let activeWorkers = 0;

function readPrinterFile(filePath) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.resolve(__dirname, 'gcodeParser.js'), {
            workerData: {
				path: filePath,
				index: activeWorkers
			},
        });

		activeWorkers++;

        worker.once('message', result => {
			resolve(result);
			worker.terminate();
		});

		worker.once('error', err => {
			reject(err);
			worker.terminate();
		});

		worker.once('exit', () => {
			activeWorkers--;
		});
    });
}








// same one as in the app.tsx for the interface
function isWithinDjoTime()
{
	if(Config.DEBUGGING)
		return true;

	const now = moment();
	const iso_day = now.isoWeekday();
	const current_time_minutes = time_to_minutes(now.format('HH:mm'));

	return (Config.DJO_TIME_MINUTES[iso_day] && current_time_minutes >= Config.DJO_TIME_MINUTES[iso_day].start_time && current_time_minutes <= Config.DJO_TIME_MINUTES[iso_day].end_time);
}


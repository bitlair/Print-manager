
import { time_to_minutes, is_empty } from './utils.js';

const BUFFER_MINUTES_TIME_DJO 	= 30;

export default {
	PRINTERS: [
		{
			ip: 		'bambu1.bitlair.nl',
			username: 	'bblp',
			password: 	'',
			serial: 	'',
			title: 		'Bambu P1S #1',
		},
		{
			ip: 		'bambu2.bitlair.nl',
			username: 	'bblp',
			password: 	'',
			serial: 	'',
			title: 		'Bambu P1S #2',
		},
		{
			ip: 		'bambu3.bitlair.nl',
			username: 	'bblp',
			password: 	'',
			serial: 	'',
			title: 		'Bambu P1S #3',
		},
		{
			ip: 		'bambu4.bitlair.nl',
			username: 	'bblp',
			password: 	'',
			serial: 	'',
			title: 		'Bambu X1C',
		},
	],
	BANK_HOST: 		'bank.bitlair.nl',
	BANK_USERNAME: 	'',
	BANK_PASSWORD: 	'',
	DJO_TIME_MINUTES: {
		// vrijdag
		5: {
			start_time: time_to_minutes('19:00') - BUFFER_MINUTES_TIME_DJO,
			end_time: 	time_to_minutes('22:00') + BUFFER_MINUTES_TIME_DJO,
		},
		// zaterdag
		6: {
			start_time: time_to_minutes('09:30') - BUFFER_MINUTES_TIME_DJO,
			end_time: 	time_to_minutes('13:30') + BUFFER_MINUTES_TIME_DJO,
		},
	},
	DEBUGGING: process.env.NODE_ENV === 'development',
}
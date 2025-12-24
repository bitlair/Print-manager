import { Client } from 'ssh2';
import Config from './config.js';
import fs from 'fs';

export default class BitlairBank
{
	pay3DPrint(weight, username)
	{
		
		try {
			const conn = new Client();

			conn.on('ready', () => {
				console.log('Client :: ready');

				conn.shell((err, stream) => {
					if (err) throw err;

					stream.on('close', () => {
						console.log('Stream :: close');
						conn.end();
					});

					stream.on('data', (data) => {
						console.log('OUTPUT: ' + data.toString());

						// You can conditionally respond to prompts here
						// For example:
						// if (data.toString().includes('Username:')) stream.write('your_username\n');
					});

					stream.stderr.on('data', (data) => {
						console.error('STDERR: ' + data.toString());
					});

					// Initial command that expects interactive input
					stream.write('3dprint\n');
					// You can chain writes like:
					stream.write(weight + '\n');
					stream.write(username + '\n');
				});
			}).connect({
				host: 		Config.BANK_HOST,
				username: 	Config.BANK_USERNAME,
				privateKey: fs.readFileSync(Config.BANK_PRIVATE_KEY_PATH), // path to your private key
				passphrase: Config.BANK_PASSPHRASE,
				//password: 	Config.BANK_PASSWORD
			});
		}
		catch(exception)
		{
			console.log('SSH failed for print with weight:', weight, ', username: ', username, ' with exception ', exception);
		}
	}
}

console.log('BITLAIRBANK INIT');


/*
let test = new BitlairBank();
setTimeout(() => {
	console.log('TESTING PAYING ');
	test.pay3DPrint(1, 'djo');
}, 5000);
*/
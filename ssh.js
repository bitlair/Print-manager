import { Client } from 'ssh2';

export default class BitlairBank
{
	pay3DPrint(weight, username)
	{
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
			host: 'bank.bitlair.nl',
			username: 'bank',
			password: 'bank'
		});
	}
}

console.log('BITLAIRBANK INIT');
let test = new BitlairBank();

/*setTimeout(() => {
	test.pay3DPrint(1);
}, 5000);*/

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

class BundlePatcher extends Transform {
	constructor() {
		super();
		this._head = [];
		this._newLinesCount = 0;
	}
	
	_transform(chunk, encoding, callback) {
		if (this._head === null) {
			callback(null, chunk);
			return;
		}

		let localOffset = 0;
		for (;localOffset < chunk.length; localOffset++) {
			if (chunk[localOffset] !== 0x0A) {
				if (chunk[localOffset] !== 0x0D) {
					this._newLinesCount = 0;
				}
			} else if (++this._newLinesCount === 2) {
				break;
			}
		}

		if (localOffset === chunk.length) {
			this._head.push(chunk);
		} else {
			this._head.push(chunk.subarray(0, localOffset));
			this._writeHead();
			this.push(chunk.subarray(localOffset))
		}

		callback();
	}

	_writeHead() {
		const asString = Buffer.concat(this._head).toString();
		this.push(Buffer.from(asString.replace(/\brefs\/remotes\/[^\/]+/g, 'refs/heads')));
		this._head = null;
	}

	_flush(callback) {
		if (this._head !== null) {
			this._writeHead();
		}
		callback();
	}
}


async function getRemoteInfo() {
	const remote = {};

	{
		const chunks = [];
		for await (const chunk of spawn('git', ['remote'], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout) {
			chunks.push(chunk);
		}
		const remoteNames = Buffer.concat(chunks).toString('utf-8').split(/[\r\n]/).filter(Boolean);
		if (remoteNames.length < 1) {
			throw new Error('This repository doesn\'t have any remotes configured');
		}
		remote.name = remoteNames[0];
	}

	{
		const chunks = [];
		for await (const chunk of spawn('git', ['remote', 'get-url', remote.name], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout) {
			chunks.push(chunk);
		}
		remote.url = Buffer.concat(chunks).toString('utf-8').trim();
	}

	return remote;
}

function whenFinishes(proc) {
	return new Promise((r, rj) => {
		proc.once('error', rj);
		proc.once('exit', (code, signal) => {
			if (signal) {
				rj(new Error(`${basename(proc.spawnfile)} was killed with signal ${signal}`));
			} else if (code !== 0) {
				rj(new Error(`${basename(proc.spawnfile)} exited with code ${code}`));
			} else {
				r();
			}
		});
	});
}

async function main(argv) {
	const filteredArgs = argv.slice(2).filter(s => !s.startsWith('-'));
	if (filteredArgs.length !== 1) {
		console.log(`Usage:\n  ${basename(argv[0])} ${basename(argv[1])} <output-file>`);
		process.exit(1);
	}

	const outputFilename = filteredArgs[0];
	const remote = await getRemoteInfo();
	console.log(`Using remote ${remote.name}`);
	
	const listProc = spawn('git', ['for-each-ref', '--format=%(refname)', `refs/remotes/${remote.name}`], { stdio: ['ignore', 'pipe', 'inherit'] });
	const bundleProc = spawn('git', ['bundle', 'create', '-', '--stdin', '--no-quiet'], { stdio: ['pipe', 'pipe', 'inherit'] });
	const whenBundleProcFinishes = whenFinishes(bundleProc);
	listProc.stdout.pipe(bundleProc.stdin);


	const zipPassword = randomBytes(12).toString('base64url');
	const zipProc = spawn('zip', ['-0', '--encrypt', '--password', zipPassword, outputFilename, '-'], { stdio: ['pipe', 'ignore', 'inherit'] });
	const whenZipProcFinishes = whenFinishes(zipProc);
	
	await pipeline(
		bundleProc.stdout,
		new BundlePatcher(),
		zipProc.stdin,
	);

	await whenBundleProcFinishes;
	await whenZipProcFinishes;

	console.log('Done! The file is:')
	console.log(`  ${outputFilename}`);
	console.log('On the receiving side, run:');
	console.log(`  unzip -P ${zipPassword} -p {PATH-TO-${basename(outputFilename)}} | git clone ${remote.url} --bundle-uri /dev/stdin`);
}

main(process.argv);
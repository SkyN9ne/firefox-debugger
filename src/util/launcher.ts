import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as rimraf from 'rimraf';
import { spawn, ChildProcess } from 'child_process';
import { LaunchConfiguration } from '../adapter/launchConfiguration';
import * as ProfileFinder from 'firefox-profile/lib/profile_finder';
import { installAddon } from './addon';

/**
 * Tries to launch Firefox with the given launch configuration. Returns either the spawned
 * child process or an error message.
 */
export function launchFirefox(config: LaunchConfiguration, addonId: string, addonPath: string): 
	Promise<ChildProcess | string> {

	let firefoxPath = getFirefoxExecutablePath(config);	
	if (!firefoxPath) {
		let errorMsg = 'Couldn\'t find the Firefox executable. ';
		if (config.firefoxExecutable) {
			errorMsg += 'Please correct the path given in your launch configuration.'
		} else {
			errorMsg += 'Please specify the path in your launch configuration.'
		}
		return Promise.resolve(errorMsg);
	}
	
	let port = config.port || 6000;
	let firefoxArgs: string[] = [ '-start-debugger-server', String(port), '-no-remote' ];

	let prepareProfilePromise: Promise<void>;
	if (config.profile) {

		firefoxArgs.push('-P', config.profile);
		if (addonId) {

			prepareProfilePromise = new Promise<void>((resolve, reject) => {
				var finder = new ProfileFinder();
				finder.getPath(config.profile, (err, profileDir) => {
					if (err) {
						reject(err);
					} else {
						let extensionsDir = path.join(profileDir, 'extensions');
						installAddon(config.addonType, addonId, addonPath, extensionsDir)
							.then(() => resolve(undefined));
					}
				});
			});

		} else {
			prepareProfilePromise = Promise.resolve(undefined);
		}

	} else {

		let [success, profileDirOrErrorMsg] = getProfileDir(config);
		if (success) {

			firefoxArgs.push('-profile', profileDirOrErrorMsg);

			if (addonId) {

				let extensionsDir = path.join(profileDirOrErrorMsg, 'extensions');
				try {
					let stat = fs.statSync(extensionsDir);
					//TODO
				} catch (e) {
					fs.mkdirSync(extensionsDir);
				}
				prepareProfilePromise = installAddon(config.addonType, addonId, addonPath, extensionsDir)
					.then(() => {});

			} else {
				prepareProfilePromise = Promise.resolve(undefined);
			}

		} else {
			return Promise.resolve(profileDirOrErrorMsg);
		}
	}

	if (Array.isArray(config.firefoxArgs)) {
		firefoxArgs = firefoxArgs.concat(config.firefoxArgs);
	}

	if (config.file) {

		if (!path.isAbsolute(config.file)) {
			return Promise.resolve('The "file" property in the launch configuration has to be an absolute path');
		}

		let fileUrl = config.file;
		if (os.platform() === 'win32') {
			fileUrl = 'file:///' + fileUrl.replace(/\\/g, '/');
		} else {
			fileUrl = 'file://' + fileUrl;
		}
		firefoxArgs.push(fileUrl);

	} else if (config.url) {
		firefoxArgs.push(config.url);
	} else if (config.addonType) {
		firefoxArgs.push('about:blank');
	} else {
		return Promise.resolve('You need to set either "file" or "url" in the launch configuration');
	}

	return prepareProfilePromise.then(() => {
		let childProc = spawn(firefoxPath, firefoxArgs, { detached: true, stdio: 'ignore' });
		childProc.unref();
		return childProc;
	});
}

export function waitForSocket(config: LaunchConfiguration): Promise<net.Socket> {
	let port = config.port || 6000;
	return new Promise<net.Socket>((resolve, reject) => {
		tryConnect(port, 200, 25, resolve, reject);
	});
}

function getFirefoxExecutablePath(config: LaunchConfiguration): string {

	if (config.firefoxExecutable) {
		if (isExecutable(config.firefoxExecutable)) {
			return config.firefoxExecutable;
		} else {
			return null;
		}
	}
	
	let candidates: string[] = [];
	switch (os.platform()) {
		
		case 'linux':
		case 'freebsd':
		case 'sunos':
			candidates = [
				'/usr/bin/firefox-developer',
				'/usr/bin/firefox'
			]
			break;

		case 'darwin':
			candidates = [
				'/Applications/FirefoxDeveloperEdition.app/Contents/MacOS/firefox',
				'/Applications/Firefox.app/Contents/MacOS/firefox'
			]
			break;

		case 'win32':
			candidates = [
				'C:\\Program Files (x86)\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
				'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
			]
			break;
	}

	for (let i = 0; i < candidates.length; i++) {
		if (isExecutable(candidates[i])) {
			return candidates[i];
		}
	}
	
	return null;
}

/**
 * Returns either true and the path of the profile directory or false and an error message
 */
function getProfileDir(config: LaunchConfiguration): [boolean, string] {
	let profileDir: string;
	if (config.profileDir) {
		profileDir = config.profileDir;
	} else {
		profileDir = path.join(os.tmpdir(), 'vscode-firefox-debug-profile');
		rimraf.sync(profileDir);
	}

	try {
		let stat = fs.statSync(profileDir);
		if (stat.isDirectory) {
			// directory exists - check permissions
			try {
				fs.accessSync(profileDir, fs.R_OK | fs.W_OK);
				return [true, profileDir];
			} catch (e) {
				return [false, `The profile directory ${profileDir} exists but can't be accessed`];
			}
		} else {
			return [false, `${profileDir} is not a directory`];
		}
	} catch (e) {
		// directory doesn't exist - create it and set the necessary user preferences
		try {
			fs.mkdirSync(profileDir);
			fs.writeFileSync(path.join(profileDir, 'prefs.js'), firefoxUserPrefs);
			return [true, profileDir];
		} catch (e) {
			return [false, `Error trying to create profile directory ${profileDir}: ${e}`];
		}
	}	
}

let firefoxUserPrefs = `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.workers", true);
user_pref("extensions.autoDisableScopes", 10);
user_pref("xpinstall.signatures.required", false);
`;

function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.X_OK);
		return true;
	} catch (e) {
		return false;
	}
}

function tryConnect(port: number, retryAfter: number, tries: number, 
	resolve: (sock: net.Socket) => void, reject: (err: any) => void) {
	
	let socket = net.connect(port);
	socket.on('connect', () => resolve(socket));
	socket.on('error', (err) => {
		if (tries > 0) {
			setTimeout(() => tryConnect(port, retryAfter, tries - 1, resolve, reject), retryAfter);
		} else {
			reject(err);
		}
	});
}

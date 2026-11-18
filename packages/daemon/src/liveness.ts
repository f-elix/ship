import type { ShipPaths } from '@ship/core/contract';
import { Effect, FileSystem } from 'effect';
import { connect } from 'node:net';

/** Whether something accepts connections on the unix socket at `path`. */
export const isListening = (path: string) =>
	Effect.callback<boolean>((resume) => {
		const socket = connect(path);
		socket.once('connect', () => {
			socket.destroy();
			resume(Effect.succeed(true));
		});
		socket.once('error', () => resume(Effect.succeed(false)));
		return Effect.sync(() => socket.destroy());
	});

/** Whether a process with this id exists (`EPERM`: it does, under another user). */
export const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && 'code' in error && error.code === 'EPERM';
	}
};

/** The pid in a pid file, or `null` when it holds none. */
export const pidIn = (text: string): number | null => {
	const pid = Number(text.trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

/** The pid of the daemon that owns the home, or `null` when its pid file is missing or empty. */
export const readDaemonPid = (paths: ShipPaths) =>
	FileSystem.FileSystem.use((fs) => fs.readFileString(paths.pidFile)).pipe(
		Effect.map(pidIn),
		Effect.orElseSucceed(() => null)
	);

/**
 * Whether a daemon may still own the home: the process in its pid file is alive, or
 * something listens on its socket. For waiting until a stopping daemon has exited (it
 * removes its socket, then its pid file): a live pid counts even without a listening
 * socket, which is looser than `claimHome`, where such a pid file is taken over.
 */
export const daemonRunning = (paths: ShipPaths) =>
	Effect.gen(function* () {
		const pid = yield* readDaemonPid(paths);
		return (pid !== null && isAlive(pid)) || (yield* isListening(paths.socket));
	});

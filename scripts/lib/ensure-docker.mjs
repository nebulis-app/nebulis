// Ensures a Docker daemon is reachable, starting Docker Desktop (macOS) or the
// docker service (Linux) and waiting for it to come up if it isn't. Used before
// any build step that shells out to `docker` (e.g. the Windows installer's
// Wine + Inno Setup step), so a cold Docker Desktop fails the release with a
// clear message instead of a `docker run` error after minutes of unrelated build work.

import { execFileSync } from 'child_process';

function isDockerResponding() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function launchDocker() {
  if (process.platform === 'darwin') {
    try {
      execFileSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
    } catch {
      throw new Error(
        'Docker Desktop is not installed (or not in /Applications). ' +
        'Install it from https://www.docker.com/products/docker-desktop/ then re-run.',
      );
    }
  } else if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['start', 'docker'], { stdio: 'ignore' });
    } catch {
      throw new Error(
        'Could not start the docker service (`systemctl start docker` failed). ' +
        'Start it manually (you may need sudo) then re-run.',
      );
    }
  } else {
    throw new Error(`Docker auto-start is not supported on ${process.platform}. Start Docker manually and re-run.`);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Resolves once `docker info` succeeds. Launches Docker if it wasn't running.
export async function ensureDockerRunning({ timeoutMs = 90_000, pollIntervalMs = 2000 } = {}) {
  if (isDockerResponding()) return;

  console.log('\n▶ Docker is not running — starting it...');
  launchDocker();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (isDockerResponding()) {
      console.log('✓ Docker is up.');
      return;
    }
    process.stdout.write('.');
  }

  throw new Error(
    `Docker did not become ready within ${Math.round(timeoutMs / 1000)}s of starting it. ` +
    'Wait for Docker Desktop to finish launching, then re-run.',
  );
}

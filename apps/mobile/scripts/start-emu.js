/**
 * start-emu.js - Start Expo dev-client with adb reverse for Android emulator
 * 
 * WHY ADB REVERSE IS REQUIRED:
 * The Android emulator runs in its own network namespace. Inside the emulator,
 * "localhost" refers to the emulator itself, not the Windows host machine.
 * When the Expo dev-client tries to connect to localhost:8081 (Metro bundler),
 * it cannot reach the host. `adb reverse` creates a tunnel so that the
 * emulator's localhost:PORT forwards to the host machine's PORT.
 * 
 * COMMON FAILURE:
 * If Windows Firewall blocks port 8081, the connection will still fail.
 * Ensure port 8081 (and 19000-19002 if used) are allowed through the firewall.
 * 
 * USAGE:
 *   pnpm --filter mobile dev:emu
 *   (or from apps/mobile: pnpm dev:emu)
 */

const { execSync, spawn } = require('child_process');

// Ports used by Expo/Metro and API
const PORTS = [
  8081,   // Metro bundler
  19000,  // Expo dev server (legacy)
  19001,  // Expo dev server
  19002,  // Expo DevTools
  3000,   // Backend API server
];

/**
 * Kill any process using the specified port (Windows only).
 * Returns true if a process was killed, false otherwise.
 */
function freePort(port) {
  try {
    // Use netstat to find PID listening on the port
    const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    
    // Parse PID from netstat output (last column)
    const lines = output.trim().split('\n');
    const pids = new Set();
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== '0') {
        pids.add(pid);
      }
    }
    
    if (pids.size === 0) {
      return false;
    }
    
    // Kill each process
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
        console.log(`  [KILLED] Process ${pid} on port ${port}`);
      } catch (e) {
        // Process might have already exited
      }
    }
    
    return true;
  } catch (err) {
    // No process found on port (findstr returns non-zero)
    return false;
  }
}

console.log('=== Android Emulator Dev Setup ===\n');

// Step 1: Free port 8081 if occupied
console.log('Checking port 8081...');
if (freePort(8081)) {
  console.log('  Port 8081 freed.\n');
} else {
  console.log('  Port 8081 is available.\n');
}

// Step 2: Run adb reverse for each port
console.log('Setting up adb reverse tunnels...');
let adbSuccess = false;

for (const port of PORTS) {
  try {
    execSync(`adb reverse tcp:${port} tcp:${port}`, { stdio: 'pipe' });
    console.log(`  [OK] adb reverse tcp:${port} tcp:${port}`);
    adbSuccess = true;
  } catch (err) {
    // Port might already be reversed or device not connected
    console.log(`  [SKIP] tcp:${port} - ${err.message.split('\n')[0]}`);
  }
}

if (!adbSuccess) {
  console.error('\n[ERROR] No adb reverse succeeded. Is the emulator running?');
  console.error('Start Android emulator first, then run this command again.');
  process.exit(1);
}

console.log('Starting Expo dev-client with --localhost...\n');
console.log('>>> Once Metro is ready, press "a" to open Android <<<\n');

// Step 3: Start Expo with dev-client and localhost mode
// --localhost tells Expo to use localhost URLs (works with adb reverse)
const expo = spawn('npx', ['expo', 'start', '--dev-client', '--localhost'], {
  stdio: 'inherit',
  shell: true,
  cwd: process.cwd(),
});

expo.on('error', (err) => {
  console.error('Failed to start Expo:', err.message);
  process.exit(1);
});

expo.on('close', (code) => {
  process.exit(code || 0);
});

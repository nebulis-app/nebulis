/**
 * Minimal in-process FTP server for testing the `ftp` telescope transport.
 *
 * Implements only what basic-ftp asks for during a session: the greeting,
 * USER/PASS, FEAT, TYPE, PWD, CWD, PASV, LIST, RETR, STOR, DELE, and QUIT.
 * Listings are emitted in Unix `ls -l` format, which is what the DWARFLAB
 * firmware serves and what basic-ftp's parser expects.
 *
 * The filesystem is an in-memory tree so a test can model a Dwarf II layout
 * (/DWARF_II/Astronomy/...) or a Dwarf 3 one (/Astronomy/...) without touching
 * disk. Binds to 127.0.0.1 on an ephemeral port.
 */
import net from 'net';

/** A directory is a map of name → entry; a file is a Buffer. */
export type FakeDir = { [name: string]: FakeDir | Buffer };

export interface FakeFtpServer {
  port: number;
  /** Commands received across all connections, in order. Lets a test assert
   *  on connection reuse and on which paths were requested. */
  commands: string[];
  /** How many TCP connections have been accepted, including the transport's
   *  reachability probes, which connect and immediately hang up. */
  socketCount: number;
  /** How many actual FTP sessions were opened (a socket that got as far as
   *  USER). This is the number that reflects control-connection pooling;
   *  `socketCount` also counts probes. */
  sessionCount: number;
  close: () => Promise<void>;
}

function isDir(entry: FakeDir | Buffer | undefined): entry is FakeDir {
  return entry !== undefined && !Buffer.isBuffer(entry);
}

/** Walk an absolute POSIX path through the tree. Returns undefined if absent. */
function resolve(root: FakeDir, absPath: string): FakeDir | Buffer | undefined {
  const segments = absPath.split('/').filter(Boolean);
  let node: FakeDir | Buffer = root;
  for (const segment of segments) {
    if (!isDir(node)) return undefined;
    const next: FakeDir | Buffer | undefined = node[segment];
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

/** One `ls -l` line. Only the type flag, size, and name are load-bearing for
 *  basic-ftp's Unix parser; the rest just has to be well-formed. */
function listLine(name: string, entry: FakeDir | Buffer): string {
  const dir = isDir(entry);
  const perms = dir ? 'drwxr-xr-x' : '-rw-r--r--';
  const size = dir ? 4096 : entry.length;
  return `${perms}   2 root root ${String(size).padStart(12)} Jan 01 00:00 ${name}`;
}

export async function startFakeFtpServer(root: FakeDir): Promise<FakeFtpServer> {
  const state: FakeFtpServer = {
    port: 0,
    commands: [],
    socketCount: 0,
    sessionCount: 0,
    close: async () => undefined,
  };

  const dataServers = new Set<net.Server>();

  const server = net.createServer(socket => {
    state.socketCount++;
    let cwd = '/';
    // Set by PASV: the listener the client will connect to for the next
    // transfer, plus a promise resolving to that connection.
    let pendingData: Promise<net.Socket> | null = null;

    const send = (line: string) => socket.write(`${line}\r\n`);

    /** Absolute-ise a possibly relative path argument. */
    const abs = (arg: string): string => {
      if (arg.startsWith('/')) return arg;
      return cwd === '/' ? `/${arg}` : `${cwd}/${arg}`;
    };

    /** Hand the queued data connection to `write`, then close it. A real
     *  server sends 150 before the transfer and 226 after; basic-ftp waits on
     *  both, so the ordering here matters. */
    const transfer = async (write: (conn: net.Socket) => void): Promise<void> => {
      if (!pendingData) return send('425 Use PASV first');
      const waiting = pendingData;
      pendingData = null;
      send('150 Opening data connection');
      const conn = await waiting;
      write(conn);
      await new Promise<void>(res => conn.end(() => res()));
      send('226 Transfer complete');
    };

    send('220 Fake DWARF FTP ready');

    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        void handle(line);
      }
    });

    const handle = async (line: string): Promise<void> => {
      const spaceAt = line.indexOf(' ');
      const cmd = (spaceAt === -1 ? line : line.slice(0, spaceAt)).toUpperCase();
      const arg = spaceAt === -1 ? '' : line.slice(spaceAt + 1);
      // Never record the password — the same discipline the real code follows.
      state.commands.push(cmd === 'PASS' ? 'PASS' : line);

      switch (cmd) {
        case 'USER':
          state.sessionCount++;
          return send('331 Password required');
        case 'PASS': return send('230 Logged in');
        case 'FEAT': return send('211 End');
        case 'SYST': return send('215 UNIX Type: L8');
        case 'TYPE': return send('200 Type set');
        case 'OPTS': return send('200 OK');
        case 'PWD':  return send(`257 "${cwd}"`);
        case 'CWD': {
          const target = abs(arg);
          if (!isDir(resolve(root, target))) return send('550 No such directory');
          cwd = target;
          return send('250 Directory changed');
        }
        case 'PASV': {
          const dataServer = net.createServer();
          dataServers.add(dataServer);
          pendingData = new Promise<net.Socket>(res => {
            dataServer.once('connection', conn => {
              dataServer.close();
              dataServers.delete(dataServer);
              res(conn);
            });
          });
          await new Promise<void>(res => dataServer.listen(0, '127.0.0.1', res));
          const addr = dataServer.address();
          const dataPort = typeof addr === 'object' && addr ? addr.port : 0;
          // 127,0,0,1,<hi>,<lo>
          return send(`227 Entering Passive Mode (127,0,0,1,${dataPort >> 8},${dataPort & 255})`);
        }
        case 'LIST':
        case 'NLST': {
          const target = arg ? abs(arg) : cwd;
          const node = resolve(root, target);
          if (!isDir(node)) return send('550 No such directory');
          return transfer(conn => {
            for (const [name, entry] of Object.entries(node)) {
              conn.write(`${listLine(name, entry)}\r\n`);
            }
          });
        }
        case 'SIZE': {
          const node = resolve(root, abs(arg));
          if (node === undefined || isDir(node)) return send('550 Not a file');
          return send(`213 ${node.length}`);
        }
        case 'RETR': {
          const node = resolve(root, abs(arg));
          if (node === undefined || isDir(node)) return send('550 No such file');
          return transfer(conn => conn.write(node));
        }
        case 'STOR': {
          const target = abs(arg);
          const parentPath = target.slice(0, target.lastIndexOf('/')) || '/';
          const parent = resolve(root, parentPath);
          if (!isDir(parent)) return send('550 No such directory');
          const name = target.slice(target.lastIndexOf('/') + 1);
          if (!pendingData) return send('425 Use PASV first');
          const waiting = pendingData;
          pendingData = null;
          send('150 Opening data connection');
          const conn = await waiting;
          const chunks: Buffer[] = [];
          conn.on('data', c => chunks.push(c));
          await new Promise<void>(res => conn.on('end', () => res()));
          parent[name] = Buffer.concat(chunks);
          return send('226 Transfer complete');
        }
        case 'DELE': {
          const target = abs(arg);
          const parentPath = target.slice(0, target.lastIndexOf('/')) || '/';
          const parent = resolve(root, parentPath);
          const name = target.slice(target.lastIndexOf('/') + 1);
          if (!isDir(parent) || parent[name] === undefined) return send('550 No such file');
          delete parent[name];
          return send('250 Deleted');
        }
        case 'QUIT':
          send('221 Bye');
          return void socket.end();
        default:
          return send('502 Not implemented');
      }
    };

    socket.on('error', () => undefined);
  });

  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  state.port = typeof addr === 'object' && addr ? addr.port : 0;
  state.close = () =>
    new Promise<void>(res => {
      for (const ds of dataServers) ds.close();
      server.close(() => res());
    });

  return state;
}

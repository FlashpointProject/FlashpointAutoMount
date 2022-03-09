import QMP from 'qemu-qmp';
import { request } from 'http';

// uuid.parse() was rejecting some uuids - this is a replacement.
export function uuidToBytes(id: string): Uint8Array {
  // Regex pattern removes all dashes.
  let strid: string = id.replace(/-/g,'');
  // "Allocate" an array to hold the output.
  let arr: Uint8Array = new Uint8Array(strid.length/2);
  // Convert each two-character pair to an int from hex.
  for (var i: number = 0; i < strid.length - 1; i += 2) {
    arr[i/2] = parseInt(strid.slice(i, i+2), 16);
  }
  return arr;
}

// Connects qmp to the given port number and host.
export async function qmpConnect(qmp: QMP, port: number, host: string): Promise<QMP> {
  // Wrap the callback in a promise.
  return new Promise((resolve, reject) => {
    // Connect to the port and host.
    qmp.connect(port, host, (err: Error) => {
      // If we get an error, reject the promise.
      if (err) return reject(err);
      // If we don't get an error, return qmp.
      resolve(qmp);
    });
  });
}

// Executes a command on a given qmp connection.
export async function qmpExecute(qmp: QMP, funcname: string, argsdict: {[key: string]: any}): Promise<QMP> {
  // Wrap the callback in a promise.
  return new Promise((resolve, reject) => {
    // Execute funcname with argsdict as its argument.
    qmp.execute(funcname, argsdict, (err: Error) => {
      // If we get an error, reject the promise.
      if (err) return reject(err);
      // If we don't get an error, return qmp.
      resolve(qmp);
    });
  });
}

// A promise to send an http request. It doesn't have to be to
// mount.php, but that's all it's used for, so the name is fine.
// qmp will be a nonsense argument if we're on docker,
// so we type it as a qmp or a number.
export async function callPHP(argsdict: {[key: string]: any}, qmp: QMP | number): Promise<{[key:string]: string | QMP | number}> {
  // Wrap the request's callback in a promise.
  return new Promise((resolve, reject) => {
    // Make a request, as specified by argsdict.
    request(argsdict, (response) => {
      // Inititalize the response string to empty.
      var str: string = '';
      // Whenever we get a chunk of data, add it to the response string.
      response.on('data', (chunk: string) => {
        str += chunk;
      });
      // When the connection ends, resolve the promise.
      response.on('end', () => {
        // Return a dictionary with str -> (response string), and qmp -> qmp.
        // Be aware: if we're on docker, qmp will be nonsense, like one.
        resolve({"str":str, "qmp": qmp});
      });
    }).end();
  });
}

// A function to nudge QMP back into responsiveness.
export async function nudgeQMP() {
  // We create an object for the new connection.
  let nudgeConn: QMP = new QMP();
  // Connect to 4445 (a separate connection), and send a simple command.
  await qmpConnect(nudgeConn, 4445, '127.0.0.1')
  .then((nudgeConn: QMP) => qmpExecute(nudgeConn, 'query-block-jobs', {}))
  .then((nudgeConn: QMP) => {
    // End the connection.
    nudgeConn.end();
  });
}

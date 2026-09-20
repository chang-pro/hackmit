import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class RobotController {
  constructor({root, spawnImpl = spawn} = {}) {
    this.root = root;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.job = {state:'idle', message:'Choose a saved destination.'};
  }
  async waypoints() {
    try { return Object.keys(JSON.parse(await readFile(join(this.root,'.reloop/robot-waypoints.json'),'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async start(destination, backend) {
    if (this.child || this.starting) throw Object.assign(new Error('A robot mission is already running.'), {status:409});
    this.starting = true;
    try {
      if (typeof destination !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(destination) || !(await this.waypoints()).includes(destination)) {
        throw Object.assign(new Error('Choose a saved destination.'), {status:400});
      }
      const python = process.env.RELOOP_DIMOS_PYTHON;
      if (!python) throw Object.assign(new Error('Set RELOOP_DIMOS_PYTHON on the backend.'), {status:503});
      this.job = {state:'running', destination, message:`Connecting to robot for ${destination}…`, photoUrl:null};
      const child = this.spawnImpl(python, ['-u',join(this.root,'scripts/robot-map-scan.py'),'go',destination,'--backend',backend,'--no-open'], {
        cwd:process.env.RELOOP_DIMOS_DIR || this.root, detached:true, stdio:['ignore','pipe','pipe'],
      });
      this.child = child;
      let output = '';
      const consume = chunk => {
        output = (output + chunk.toString()).slice(-16000);
        if (this.job.state === 'stopping') return;
        if (output.includes('Snapshot submitted.')) this.job.message = 'Photo captured. Pricing objects…';
        else if (output.includes('Arrived and stopped.')) this.job.message = 'Arrived. Taking a photo…';
        else if (output.includes('Navigating to ')) this.job.message = `Navigating to ${destination}…`;
        const match = output.match(/\/live\?photo=(pho_[a-zA-Z0-9_-]+)/);
        if (match) this.job.photoUrl = '/live?photo=' + match[1];
      };
      child.stdout.on('data',consume);
      child.stderr.on('data',consume);
      child.on('error', () => { this.job.state='failed'; this.job.message='Could not start the dimOS mission process.'; this.child=null; });
      child.on('close', code => {
        const cancelled = this.job.state === 'stopping';
        this.job.state = cancelled ? 'cancelled' : code === 0 && this.job.photoUrl ? 'complete' : 'failed';
        this.job.message = cancelled ? 'Mission cancelled.' : this.job.state === 'complete' ? 'Scan ready. Choose what to sell or keep.' :
          output.match(/Mission stopped: ([^\n]+)/)?.[1] || 'Mission failed. Check the backend terminal and dimOS connection.';
        this.child=null;
      });
      return this.job;
    } finally { this.starting=false; }
  }
  cancel() {
    if (this.child) {
      this.job.state='stopping'; this.job.message='Stopping the mission…';
      try { process.kill(-this.child.pid, 'SIGINT'); } catch(e) { if(e.code !== 'ESRCH') throw e; }
    }
    return this.job;
  }
}

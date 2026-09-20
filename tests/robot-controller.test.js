import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {RobotController} from '../services/robot/controller.js';
function fixture() {
 let args;
 const child=new EventEmitter(); child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 const c=new RobotController({root:'/tmp/reloop',spawnImpl:(...a)=>{args=a;return child;}});
 c.waypoints=async()=>['table'];
 return {c,child,args:()=>args};
}
test('only saved names can launch; fixed script args and one mission at a time',async()=>{
 const old=process.env.RELOOP_DIMOS_PYTHON; process.env.RELOOP_DIMOS_PYTHON='/test/python';
 try {
 const {c,child,args}=fixture();
 await assert.rejects(c.start('table; touch /tmp/no','http://localhost'), /saved/);
 await c.start('table','http://127.0.0.1:3000');
 assert.equal(args()[1].includes('--no-open'),true);
 await assert.rejects(c.start('table','http://localhost'),/already/);
 child.stdout.emit('data','Navigating to table.\n'); assert.match(c.job.message,/Navigating/);
 child.stdout.emit('data','Snapshot submitted. Waiting for pricing…\nhttp://127.0.0.1:3000/live?photo=pho_abc-123\n');
 child.emit('close',0); assert.equal(c.job.state,'complete');assert.equal(c.job.photoUrl,'/live?photo=pho_abc-123');
 } finally {if(old===undefined)delete process.env.RELOOP_DIMOS_PYTHON;else process.env.RELOOP_DIMOS_PYTHON=old;}
});
test('failure is shown without inventing a scan',async()=>{
 const old=process.env.RELOOP_DIMOS_PYTHON;process.env.RELOOP_DIMOS_PYTHON='/test/python';
 try { const {c,child}=fixture();await c.start('table','http://localhost');
 child.stderr.emit('data','Mission stopped: Viewpoint belongs to an earlier run.\n');child.emit('close',1);
 assert.equal(c.job.state,'failed');assert.match(c.job.message,/earlier run/);assert.equal(c.job.photoUrl,null);
 } finally {if(old===undefined)delete process.env.RELOOP_DIMOS_PYTHON;else process.env.RELOOP_DIMOS_PYTHON=old;}
});

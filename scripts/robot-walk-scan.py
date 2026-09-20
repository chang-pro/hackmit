"""Walk approximately 0.4 m using odometry, stop, then run robot-scan.py."""
import argparse
import math
from pathlib import Path
import subprocess
import sys
import time



def walk_forward(robot, twist_factory, distance=0.4, clock=time.monotonic):
    def pose():
        value = robot.peek_stream('odom', 1.0)
        if value is None or not all(math.isfinite(float(getattr(value, k, math.nan))) for k in ('x', 'y', 'yaw', 'ts')):
            raise RuntimeError('No valid odometry; stopping without scanning.')
        return value

    try:
        start = pose()
        previous = start
        deadline = clock() + 25
        last_progress_time = clock()
        best = 0.0
        while clock() < deadline:
            current = pose()
            if current.ts <= previous.ts:
                raise RuntimeError('Odometry stopped updating.')
            if current.frame_id != start.frame_id:
                raise RuntimeError('Odometry reference frame changed.')
            if math.hypot(current.x - previous.x, current.y - previous.y) > 0.15:
                raise RuntimeError('Odometry jumped; stopping.')
            dx, dy = current.x - start.x, current.y - start.y
            forward = dx * math.cos(start.yaw) + dy * math.sin(start.yaw)
            lateral = -dx * math.sin(start.yaw) + dy * math.cos(start.yaw)
            heading = math.atan2(math.sin(current.yaw - start.yaw), math.cos(current.yaw - start.yaw))
            if abs(lateral) > 0.10 or abs(heading) > math.radians(15) or forward < -0.05:
                raise RuntimeError('Robot deviated from the straight path; stopping.')
            if forward >= distance:
                print(f'Stopped after {forward:.2f} m measured forward travel.', flush=True)
                return forward
            if forward > best + 0.01:
                best, last_progress_time = forward, clock()
            if clock() - last_progress_time > 5:
                raise RuntimeError('No forward progress; stopping without scanning.')
            # Short bounded pulses: each call stops itself before we read odometry.
            # This avoids leaving a continuous movement active during RPC delays.
            if not robot.move(twist_factory(linear=(0.15, 0, 0), angular=(0, 0, 0)), duration=0.2):
                raise RuntimeError('Robot rejected the movement command.')
            previous = current
        raise TimeoutError('Travel timed out; stopping without scanning.')
    finally:
        robot.stop_movement()


def main():
    import requests
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', default='http://127.0.0.1:3000')
    args = parser.parse_args()
    requests.get(args.backend.rstrip('/') + '/api/health', timeout=5).raise_for_status()
    from dimos import Dimos
    from dimos.msgs.geometry_msgs.Twist import Twist
    app = Dimos.connect()
    try:
        if app.WavefrontFrontierExplorer.is_exploration_active():
            raise RuntimeError('Stop autonomous exploration before running this demo.')
        if app.ReplanningAStarPlanner.get_state().value != 'idle':
            raise RuntimeError('Finish or cancel the current map mission first.')
        print('Moving forward approximately 0.4 m. Ctrl+C stops this demo.', flush=True)
        walk_forward(app.GO2Connection, Twist)
        time.sleep(1)
    finally:
        app.stop()  # Disconnect the remote client, not the robot coordinator.
    subprocess.run([sys.executable, str(Path(__file__).with_name('robot-scan.py')),
                    '--backend', args.backend], check=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nDemo interrupted; scan not started.')
        sys.exit(130)

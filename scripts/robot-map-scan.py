"""Save a viewpoint in the current dimOS session, or navigate there and scan."""
import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

WAYPOINTS = Path(__file__).resolve().parents[1] / '.reloop' / 'robot-waypoints.json'
# Scan acceptance only; these do not change the planner's obstacle clearance.
SCAN_POSITION_TOLERANCE = 0.5
SCAN_HEADING_TOLERANCE = math.radians(20)


def active_run():
    from dimos.core.run_registry import get_most_recent
    entry = get_most_recent(alive_only=True)
    if entry is None or entry.blueprint != 'unitree-go2':
        raise RuntimeError('Start your unitree-go2 session first.')
    return entry.run_id


def read_pose(robot):
    pose = robot.peek_stream('odom', 3.0)
    if pose is None:
        raise RuntimeError(
            'DimOS is not receiving robot position updates. Restart the DimOS '
            'session, then save the viewpoint again in the new map before retrying.'
        )
    if not getattr(pose, 'frame_id', None) or not all(
        math.isfinite(float(getattr(pose, key, math.nan)))
        for key in ('x', 'y', 'z', 'yaw', 'ts')
    ):
        raise RuntimeError('No valid robot pose received.')
    if abs(time.time() - pose.ts) > 5:
        raise RuntimeError('Odometry is stale; no mission started.')
    return pose


def check_connection(app):
    """Inspect fresh sensor samples without issuing any motion commands."""
    failures = []
    try:
        pose = read_pose(app.GO2Connection)
        print(f'Position: OK ({pose.frame_id})', flush=True)
    except RuntimeError as error:
        failures.append(str(error))
        print(f'Position: {error}', flush=True)
    for stream, label in [('lidar', 'Lidar'), ('color_image', 'Camera')]:
        sample = app.GO2Connection.peek_stream(stream, 3.0)
        ts = getattr(sample, 'ts', math.nan)
        valid = math.isfinite(float(ts)) and abs(time.time() - ts) <= 5
        print(f'{label}: {"OK" if valid else "no fresh data"}', flush=True)
        if not valid:
            failures.append(f'{label} has no fresh data.')
    if failures:
        raise RuntimeError('Sensor check failed. No movement commanded.')
    print('Sensor check passed. No movement commanded.', flush=True)


def require_idle(app):
    if app.WavefrontFrontierExplorer.is_exploration_active():
        raise RuntimeError('Stop exploration before saving or running a viewpoint mission.')
    if app.ReplanningAStarPlanner.get_state().value != 'idle':
        raise RuntimeError('Finish or cancel the existing map destination first.')


def validate_waypoint(point, run_id, frame_id):
    if point['run_id'] != run_id:
        raise RuntimeError('This viewpoint belongs to an earlier dimOS run. Save it again in the current map.')
    if point['frame_id'] != frame_id:
        raise RuntimeError('The map reference frame changed. Save the viewpoint again.')


def navigate(app, goal, timeout=120, clock=time.monotonic, sleep=time.sleep):
    planner = app.ReplanningAStarPlanner
    robot = app.GO2Connection
    try:
        if not planner.set_goal(goal):
            raise RuntimeError('Navigation rejected the destination.')
        deadline = clock() + timeout
        idle_since = None
        while True:
            now = clock()
            if now >= deadline:
                break
            if planner.is_goal_reached():
                # Verify both position and viewing direction before scanning.
                pose = read_pose(robot)
                distance = math.hypot(pose.x - goal.x, pose.y - goal.y)
                angle = abs(math.atan2(math.sin(pose.yaw - goal.yaw), math.cos(pose.yaw - goal.yaw)))
                if pose.frame_id != goal.frame_id:
                    raise RuntimeError('Arrival reference frame changed; save the viewpoint again. Scan cancelled.')
                if distance > SCAN_POSITION_TOLERANCE or angle > SCAN_HEADING_TOLERANCE:
                    raise RuntimeError(
                        'Arrival reported but viewpoint does not match: '
                        f'{distance:.2f} m away (limit {SCAN_POSITION_TOLERANCE:.2f} m), '
                        f'{math.degrees(angle):.1f} degrees off (limit 20). '
                        'Save a clear viewpoint facing the objects and retry; scan cancelled.'
                    )
                return
            if planner.get_state().value == 'idle':
                # DimOS exposes local "arrived" as IDLE before its global
                # planner sets is_goal_reached on another thread. Do not cancel
                # that handoff. Idle alone must never authorize a scan.
                if idle_since is None:
                    idle_since = now
                elif now - idle_since >= 2.0:
                    raise RuntimeError('Navigation ended without reaching the viewpoint; scan cancelled.')
            else:
                idle_since = None
            sleep(0.25)
        raise TimeoutError('Navigation timed out; scan cancelled.')
    finally:
        try:
            planner.cancel_goal()
        finally:
            robot.stop_movement()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['save', 'go', 'list', 'check'])
    parser.add_argument('name', nargs='?', default='table')
    parser.add_argument('--backend', default='http://127.0.0.1:3000')
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}', args.name):
        parser.error('Use a short waypoint name containing letters, numbers, underscores or hyphens.')
    points = json.loads(WAYPOINTS.read_text()) if WAYPOINTS.exists() else {}
    if args.action == 'list':
        for name, point in points.items():
            print(f"{name}: {point['position']} (run {point['run_id']})")
        if not points:
            print('No saved viewpoints yet.')
        return
    if args.action == 'go':
        if args.name not in points:
            raise RuntimeError(f'No saved viewpoint named {args.name}. Run save first.')
        import requests
        requests.get(args.backend.rstrip('/') + '/api/health', timeout=5).raise_for_status()
    from dimos import Dimos
    from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
    run_id = active_run()
    app = Dimos.connect()
    try:
        if args.action == 'check':
            check_connection(app)
            return
        require_idle(app)
        pose = read_pose(app.GO2Connection)
        if args.action == 'save':
            points[args.name] = {
                'run_id': run_id, 'frame_id': pose.frame_id,
                'position': [pose.x, pose.y, pose.z],
                'orientation': [pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w],
            }
            WAYPOINTS.parent.mkdir(parents=True, exist_ok=True)
            WAYPOINTS.write_text(json.dumps(points, indent=2) + '\n')
            print(f'Saved {args.name}: position and viewing direction. No movement commanded.')
            return
        point = points[args.name]
        validate_waypoint(point, run_id, pose.frame_id)
        goal = PoseStamped(frame_id=point['frame_id'], position=point['position'], orientation=point['orientation'])
        print(f'Navigating to {args.name}. Ctrl+C cancels the mission.', flush=True)
        navigate(app, goal)
        print('Arrived and stopped. Capturing after settling…', flush=True)
        time.sleep(1)
    finally:
        app.stop()  # Disconnect this client only.
    subprocess.run([sys.executable, str(Path(__file__).with_name('robot-scan.py')),
                    '--backend', args.backend] + (['--no-open'] if args.no_open else []), check=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nMission cancelled.')
        sys.exit(130)
    except Exception as error:
        print(f'Mission stopped: {error}', file=sys.stderr)
        sys.exit(1)

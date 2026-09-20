import importlib.util
from pathlib import Path
from types import SimpleNamespace
import time
import pytest

spec = importlib.util.spec_from_file_location('robot_map', Path(__file__).parents[1] / 'scripts/robot-map-scan.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Planner:
    def __init__(self, reached=True, state='idle'):
        self.reached, self.state, self.cancelled = reached, state, False
    def set_goal(self, goal):
        self.goal = goal
        return True
    def is_goal_reached(self): return self.reached
    def get_state(self): return SimpleNamespace(value=self.state)
    def cancel_goal(self): self.cancelled = True

class Robot:
    def __init__(self, x=1): self.x, self.stopped = x, False
    def peek_stream(self, *args):
        return SimpleNamespace(x=self.x, y=2, z=0, yaw=0, frame_id='world', ts=time.time())
    def stop_movement(self): self.stopped = True

def app(reached=True, state='idle', x=1):
    return SimpleNamespace(ReplanningAStarPlanner=Planner(reached, state), GO2Connection=Robot(x))

goal = SimpleNamespace(x=1, y=2, yaw=0, frame_id='world')

def test_arrival_stops_before_return():
    a = app()
    module.navigate(a, goal)
    assert a.GO2Connection.stopped and a.ReplanningAStarPlanner.cancelled

def test_failed_navigation_does_not_report_success():
    a = app(False)
    ticks = iter([0, 0, 1, 2])
    with pytest.raises(RuntimeError, match='without reaching'):
        module.navigate(a, goal, clock=lambda:next(ticks), sleep=lambda _:None)
    assert a.GO2Connection.stopped and a.ReplanningAStarPlanner.cancelled

def test_idle_before_arrival_flag_does_not_cancel_handoff():
    a = app(False)
    def handoff(_):
        assert not a.ReplanningAStarPlanner.cancelled
        a.ReplanningAStarPlanner.reached = True
    module.navigate(a, goal, sleep=handoff)
    assert a.GO2Connection.stopped and a.ReplanningAStarPlanner.cancelled

def test_delayed_arrival_still_requires_correct_viewpoint():
    a = app(False, x=3)
    def handoff(_):
        a.ReplanningAStarPlanner.reached = True
    with pytest.raises(RuntimeError, match='does not match'):
        module.navigate(a, goal, sleep=handoff)
    assert a.GO2Connection.stopped

def test_transient_idle_during_replanning_can_resume():
    a = app(False)
    ticks = iter([0, 0, 1, 2, 3])
    states = iter(['following_path', 'idle', 'idle'])
    calls = 0
    def progress(_):
        nonlocal calls
        calls += 1
        a.ReplanningAStarPlanner.state = next(states)
        if calls == 3:
            a.ReplanningAStarPlanner.reached = True
    module.navigate(a, goal, clock=lambda:next(ticks), sleep=progress)
    assert a.GO2Connection.stopped

def test_wrong_viewpoint_rejected():
    a = app(x=3)
    with pytest.raises(RuntimeError, match='does not match'):
        module.navigate(a, goal)
    assert a.GO2Connection.stopped

def test_old_map_rejected():
    with pytest.raises(RuntimeError, match='earlier'):
        module.validate_waypoint({'run_id':'old', 'frame_id':'world'}, 'new', 'world')

def test_timeout_cancels():
    a = app(False, 'following_path')
    ticks = iter([0, 0, 2])
    with pytest.raises(TimeoutError):
        module.navigate(a, goal, timeout=1, clock=lambda:next(ticks), sleep=lambda _:None)
    assert a.GO2Connection.stopped and a.ReplanningAStarPlanner.cancelled

def test_missing_pose_reports_recovery():
    robot = SimpleNamespace(peek_stream=lambda *args: None)
    with pytest.raises(RuntimeError, match='not receiving robot position'):
        module.read_pose(robot)

def test_stale_pose_rejected():
    robot = SimpleNamespace(peek_stream=lambda *args: SimpleNamespace(
        x=1, y=2, z=0, yaw=0, frame_id='world', ts=time.time()-30))
    with pytest.raises(RuntimeError, match='stale'):
        module.read_pose(robot)

def test_check_inspects_all_sensors_on_pose_failure(capsys):
    requested = []
    def peek(name, timeout):
        requested.append(name)
        return SimpleNamespace(ts=time.time()) if name == 'color_image' else None
    a = SimpleNamespace(GO2Connection=SimpleNamespace(peek_stream=peek))
    with pytest.raises(RuntimeError, match='No movement commanded'):
        module.check_connection(a)
    assert requested == ['odom', 'lidar', 'color_image']
    assert 'Camera: OK' in capsys.readouterr().out

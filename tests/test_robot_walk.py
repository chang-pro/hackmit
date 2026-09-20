import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest

spec = importlib.util.spec_from_file_location('robot_walk', Path(__file__).parents[1] / 'scripts/robot-walk-scan.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Robot:
    def __init__(self, positions):
        self.positions = iter(positions)
        self.stopped = False
        self.moves = 0
    def peek_stream(self, *_):
        return next(self.positions)
    def move(self, *args, **kwargs):
        assert kwargs['duration'] == 0.2
        self.moves += 1
        return True
    def stop_movement(self):
        self.stopped = True

def pose(x, ts, y=0):
    return SimpleNamespace(x=x, y=y, yaw=0, ts=ts, frame_id='world')

def test_measured_distance_and_stop():
    r = Robot([pose(x, i) for i, x in enumerate([0, 0, .1, .2, .3, .4])])
    assert module.walk_forward(r, lambda **kw: kw) == .4
    assert r.moves == 4 and r.stopped

def test_stale_odometry_stops():
    r = Robot([pose(0, 1), pose(0, 1)])
    with pytest.raises(RuntimeError, match='updating'):
        module.walk_forward(r, lambda **kw: kw)
    assert r.stopped and not r.moves

def test_sideways_motion_stops():
    r = Robot([pose(0, 1), pose(0, 2, y=.12)])
    with pytest.raises(RuntimeError, match='deviated'):
        module.walk_forward(r, lambda **kw: kw)
    assert r.stopped and not r.moves

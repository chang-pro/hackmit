# Robot demo

Current milestone: move straight forward approximately 0.4 m, stop, capture a
fresh full-frame image, price up to eight objects, and open the existing
sell/keep picker. Listing still requires user approval.

Keep the existing dimOS session and ReLoop backend running. With a clear path,
no active map/exploration mission, and no simultaneous keyboard driving, run:

```bash
cd /Users/berketunc/dimos
.venv/bin/python /Users/berketunc/hackmit/scripts/robot-walk-scan.py
```

Travel is measured from odometry along the initial heading. Short forward pulses
stop between measurements; exact physical distance depends on odometry and
stopping dynamics. A travel timeout, stalled or discontinuous odometry, or excess
heading/lateral deviation aborts before scanning. Ctrl+C also requests a stop.
Use the robot's existing stop control if the connection is lost.

The motion logic has fake-robot tests; physical motion is not yet verified.
The standalone camera-to-pricing-to-picker flow has been verified on hardware.

Deferred: save a table viewpoint within the map session, navigate to it, trigger
this same scan on confirmed arrival, then add a natural-language mission trigger.

## Map viewpoint mission

The map mission is implemented; the user confirmed successful physical navigation and scanning.
Drive to the desired scan position and face the objects, then stop. In a regular
terminal (not the dimOS Python shell):

```bash
cd /Users/berketunc/dimos
.venv/bin/python /Users/berketunc/hackmit/scripts/robot-map-scan.py save table
```

Saving reads odometry and writes `.reloop/robot-waypoints.json` (gitignored).
It does not move the robot. Repeating save replaces that named viewpoint.
Move elsewhere using the existing controls and finish that movement. Then:

```bash
.venv/bin/python /Users/berketunc/hackmit/scripts/robot-map-scan.py go table
```

This sends a planner goal, waits up to 120 seconds for arrival, verifies position
and orientation, stops, settles, and invokes the existing scan/picker. It does
not approve or publish listings. Avoid simultaneous keyboard or map commands.
Ctrl+C cancels the goal and requests a stop. Keep the existing robot stop control
available in case the control connection fails.

Viewpoints are valid only in the recorded dimOS run and coordinate frame.
Save again after restarting dimOS or resetting/relocalizing the map. Automatic
map resets within the same run cannot all be detected. Voice commands and finding
previously unknown tables remain deferred.

## Dashboard controls

Open `/` on the backend Mac. Click **Control the dog**, enter
`table` (or another saved name), and click **Go and scan**. The panel tracks the
mission and offers **Stop**. Once pricing finishes, **Review scanned items**
opens the frozen photo picker. Select items, create/review a plan, choose Shopify,
and approve the listing using the existing controls.

Configure `RELOOP_DIMOS_PYTHON` and `RELOOP_DIMOS_DIR` in the backend's `.env`.
Robot HTTP controls are limited to loopback clients; use `127.0.0.1` on the Mac.
Only one dashboard mission can run at a time. This does not lock out Dimensional's
keyboard/map controls, so avoid operating those simultaneously.

Shopify client credentials are supported by the existing token exchange. Set
`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_STORE_DOMAIN`, and `DRY_RUN=0`
in `.env`. Credentials stay server-side. Product access was verified against the
configured store; actual product publication remains behind user approval.

## Position stream unavailable

If the dashboard reports missing robot position updates, inspect sensors without
moving the robot:

```bash
cd /Users/berketunc/dimos
.venv/bin/python /Users/berketunc/hackmit/scripts/robot-map-scan.py check
```

Camera video can continue while lidar and odometry are unavailable. Restart the
DimOS session using the original launch command, then repeat the check. After all
three sensors report OK, drive to the table viewpoint, stop, and run `save table`
again. Restarting invalidates the previous saved map coordinates; do not reuse
them by editing the run ID. Then retry **Go and scan** from the dashboard.

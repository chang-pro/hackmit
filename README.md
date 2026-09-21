# LOS / Loop OS (ReLoop)

> Look at your stuff. Choose what gets a second life.

[Watch the project video on YouTube](https://www.youtube.com/watch?v=JUU9ym95eUg).

Loop OS helps turn a view of unused belongings into resale decisions. An image from Meta glasses, a phone, or a Unitree Go2 robot reaches the same backend. The app identifies visible items, suggests **estimated** secondhand values, and lets the owner choose what to keep, sell, donate, or recycle. Approved sale items can become Shopify products; Facebook Marketplace uses a separate draft workflow that still needs a person to publish.

The repository and some app identifiers still say **ReLoop** or **BloomKnights**. The presentation name is **LOS / Loop OS**. Do not rename the iOS bundle ID or URL scheme casually: they are tied to the team's Meta developer registration.

## Start the web app

Use a recent Node.js version that supports `--env-file-if-exists` (the team currently runs Node 26). From this repository:

```bash
npm start
```

Open **http://127.0.0.1:3000/**. The server loads the repository's `.env` if present. Check `http://127.0.0.1:3000/api/health` if the page is unavailable. Stop the server with Ctrl+C; starting DimOS does not start the web app.

For live item analysis, configure one provider in a gitignored `.env`:

```dotenv
ITEMS_PROVIDER=gemini
GEMINI_API_KEY=your-private-key
GEMINI_ITEMS_MODEL=gemini-3.6-flash
```

Alternatively, set `RIGHTCODES_KEY_GEMINI` and select `ITEMS_PROVIDER=rightcodes`. With no explicit selection, right.codes takes precedence when its key is set; the direct Gemini adapter is selected when only `GEMINI_API_KEY` is set. If both keys exist, the other provider is used as a fallback when the selected one fails. An absent or exhausted key does not make the app generate real prices. Keep credentials out of source, screenshots, and commits; `.env` is ignored by Git.

`npm start` does not require installing packages for the core server. `npm install` is needed for the optional MCP catalog. Run the Node tests with `npm test`.

## Use the product

1. Capture a view with the glasses/iPhone path, the browser/phone path, or a robot scan. The main page shows the latest photo and up to eight identified items with estimated prices.
2. Choose a goal or cash target, then **Review** the proposed actions and reasons. Unselect anything you want to keep; correct item details where needed.
3. Choose Shopify, Facebook Marketplace, or both. **Yes, list them** is the explicit approval step for eligible items.
4. Shopify products are created and published when a working store connection is configured. Marketplace is a draft handoff through muse.ai; a human completes publication in Facebook. The status page shows what happened in each channel.

Prices are model estimates before fees and shipping, not confirmed sold-comparable values or guaranteed proceeds. A photo cannot establish hidden contents, a precise variant, or whether electronics work. Donation and recycling are suggestions, not completed drop-offs. The repo includes a mock checkout for demos; it is not a payment processor.

The main browser routes are:

| Route | Purpose |
| --- | --- |
| `/` or `/live` | Live feed, item picker, plan, and listing approval; also contains robot controls |
| `/dashboard` | Event-based goal and listing dashboard |
| `/status` | Listing/channel status and buyer conversations |
| `/confirm` | Voice confirmation flow |
| `/api/health`, `/api/analysis/status`, `/api/items/latest` | Basic diagnostics |

Continuous frame analysis is off by default. Start it from the page or `POST /api/analysis/start`; `RELOOP_PRICING_ON=1` arms it at startup. Explicit glasses and robot still-photo submissions are analyzed as individual captures. Frames from all supported sources enter `POST /api/frames` and are processed by the same item analyzer. The backend checks item boxes and serializes analysis calls to limit duplicate work.

## Glasses and iPhone

The SwiftUI iPhone companion lives in [`apps/ios/BloomKnights/`](apps/ios/BloomKnights/). It uses the Meta Wearables Device Access Toolkit for glasses capture and the team's phone/WebRTC path to get images into ReLoop. Follow the [iOS setup guide](apps/ios/README.md) for XcodeGen, signing, device trust, Developer Mode, and camera troubleshooting. The iOS project name and bundle ID remain BloomKnights for Meta registration compatibility.

The page displays item labels and estimated prices over the image. When presenting a frozen photo, users can tap or untick detected items to exclude them from the plan. The photo selected for a listing is stored separately from the live stream.

## Robot capture and saved destinations

The Unitree Go2 runs Dimensional's DimOS. DimOS and the ReLoop backend run on the Mac; the robot supplies motion, lidar, odometry, and camera images. Robot missions use **named viewpoints saved in the current DimOS map**, such as `table` or `sponsor`. This is not autonomous discovery of an unfamiliar table or free exploration of a room.

Start one working `unitree-go2` DimOS session using the robot's **current** IP and your locally held connection key. Do not put that key in the README or shell history shared with others. From the DimOS checkout, run the sensor check and save each destination while the robot is stationary and facing the objects:

```bash
cd /Users/berketunc/dimos
.venv/bin/python /Users/berketunc/hackmit/scripts/robot-map-scan.py check
.venv/bin/python /Users/berketunc/hackmit/scripts/robot-map-scan.py save table
.venv/bin/python /Users/berketunc/hackmit/scripts/robot-map-scan.py save sponsor
```

Saving records the current position and viewing direction in `.reloop/robot-waypoints.json`; it does **not** move the robot. Drive to a different location before saving another name. Saved viewpoints are valid only for that DimOS run and map frame: after a restart or map reset, check sensors and re-save them. If DimOS reports that the robot's signaling ports are unavailable, verify the robot's current IP and Wi-Fi connection before relaunching it.

Set these in the web backend's `.env` and restart `npm start`:

```dotenv
RELOOP_DIMOS_PYTHON=/Users/berketunc/dimos/.venv/bin/python
RELOOP_DIMOS_DIR=/Users/berketunc/dimos
```

On **http://127.0.0.1:3000/**, open **Control the dog**, type an exact saved name, then select **Go and scan**. The app starts one mission at a time, waits for DimOS navigation, verifies a fresh pose within **0.5 m and 20°** of the saved viewpoint, stops, captures a still, and opens the usual item review. The panel also has **Stop**. Do not send simultaneous keyboard or map movement commands; keep the robot's own stop control available. Robot-control HTTP routes are restricted to local requests on the Mac.

For a camera-only capture, use `scripts/robot-scan.py`. For the experimental straight-line 0.4 m walk then capture, use `scripts/robot-walk-scan.py`. The [robot demo guide](docs/robot-demo.md) gives the full commands and recovery notes. Navigation-to-scan has been tested on the team's physical robot; a destination can still fail if sensors, map, or connection are unavailable.

## Shopify and Facebook Marketplace

Shopify supports either an installed app's client ID and secret or an Admin API access token. Put only the credential type you have in `.env`:

```dotenv
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your-client-id
SHOPIFY_CLIENT_SECRET=your-client-secret
DRY_RUN=0
```

For a token-based app, use `SHOPIFY_ADMIN_ACCESS_TOKEN` instead of the client ID/secret. `DRY_RUN=1` simulates publication. A created Shopify product may need publication to the Online Store sales channel before its URL works; the integration reports a channel-publication failure rather than treating a dead URL as success. The [Shopify guide](services/shopify/README.md) explains scopes and testing. Never confuse an app secret (`shpss_…`) with an access token (`shpat_…`).

Facebook Marketplace is optional and disabled unless `RELOOP_MARKETPLACE_DRAFTS=1`. It uses a dedicated, logged-in Chrome session and muse.ai to prepare drafts. The owner must finish publication in Facebook and can then mark it published in the app. See the [Marketplace setup guide](facebook-marketplace/README.md). Shopify publication, Marketplace drafting, buyer messaging, and mock checkout are distinct states.

## How the code is organized

```text
apps/ios/                 SwiftUI phone and Meta glasses companion
apps/demo-web/            Main feed, dashboard, status, and robot controls
services/api/             Node HTTP server and item-analysis queue
services/capture/         Frame ingestion, selection, and optional dataset writer
services/vision/backends/ Direct Gemini and right.codes item providers
services/market/          Goal planner, approvals, catalog, seller agent, drafts
services/shopify/         Shopify Admin API integration
services/events/          Event log and dashboard fold
services/robot/           Dashboard mission process controller
scripts/robot-*.py        DimOS sensor, navigation, and still-photo workflows
reloop_brain/             Earlier standalone Python Lane B prototype
tests/                    Node tests plus robot Python tests
```

The running web product uses **one Node server**, `services/api/server.js`, on port 3000. `reloop_brain/` is an earlier standalone FastAPI/prototype implementation; it is not the runtime pricing service for the Node app. Its demo prices are development fixtures. Do not run its `uvicorn` server expecting the current dashboard or claim those prices are researched market data.

The main API surfaces include `POST /api/frames`, `GET /api/items/latest`, `POST /api/plans`, `POST /api/plans/:id/approve`, listing/status routes, and `GET /api/robot/status` plus `POST /api/robot/go` and `/api/robot/stop`. The server source and [market-flow notes](docs/architecture/MARKET.md) have the detailed request shapes. Some older architecture and launch documents still describe an abandoned sports-prediction prototype; they are not documentation for the current runtime.

Market state defaults to `data/market_state.json` and listing photos to `data/photos/`; both are ignored by Git. Event persistence requires `RELOOP_EVENTS_FILE` to be set. The optional training dataset writer is off unless `DATASET_DIR` is set. The robot's saved viewpoints are also local and ignored. Back up local state separately if it matters.

## Verification and demo preparation

```bash
npm test
.venv/bin/python -m pytest tests/test_robot_map.py tests/test_robot_walk.py -q
```

The Python tests exercise robot safety logic with fake modules; they do not replace a live sensor and navigation check. Before a demo, verify the web app responds, the selected pricing provider has quota, the glasses capture reaches the backend, DimOS has fresh position/lidar/camera data, and the Shopify/Marketplace account state matches what you intend to show. A recorded run should be labeled as recorded if used as a fallback.

Loop OS currently has **no measured pricing accuracy, resale conversion rate, or environmental impact figure**. Better completed-sale evidence, multi-view item identification, and richer robot destination understanding are future work.

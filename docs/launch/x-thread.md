# ReLoop launch thread (X/Twitter)

Voice: Dechante (voice-dna). No em-dashes. 7 tweets.

---

**Tweet 1 (hook)**

I built glasses that read the scoreboard for you.

Point Meta Ray-Bans at any live game. AI vision reads the broadcast, a probability model estimates who wins, and it checks that against the Polymarket price. Whispered in your ear. You never look away.

Watch. 🧵

**Tweet 2 (how)**

Here's exactly how it works:

- glasses see the broadcast
- vision pulls teams, score, period, clock as typed JSON
- a deterministic model turns that state into a win probability
- an adapter grabs the market-implied probability from Polymarket
- you hear: "Boston 68%. Market 59%."

No app-switching. No searching for contracts.

**Tweet 3 (honesty undercut)**

To be straight: this is not "beat the market" magic. It's not magic at all.

The model measures one thing, the market measures another. A 9-point gap is a signal to inspect, not free money. The system literally refuses to answer when the scoreboard read is shaky. That refusal is a feature I built on purpose.

**Tweet 4 (the Super Bowl LI beat)**

The demo that sells it: Super Bowl LI, replayed through the system.

Q3, 8:31 left. Atlanta 28, New England 3. The market has basically buried the Patriots.

Q4, 0:57 left. 28 all.

You can watch the model estimate and the market price fight each other in real time as the comeback happens. Labeled as a replay, real math.

**Tweet 5 (build receipts)**

Built the whole backend in zero-dependency Node. Not one npm install.

5 sports: NBA, NFL, soccer, UFC, golf. Brownian motion for basketball and football, Poisson goals for soccer. Gemini vision behind a swappable seam, so tests run on committed fixtures and never lie to me.

Real code, real tests, real fixtures.

**Tweet 6 (the rest of the stack)**

Also shipped:

- SwiftUI iOS companion that polls the backend and speaks the result
- a data dashboard
- a 60-second film rendered from HTML with HyperFrames
- an opt-in flywheel that saves labeled scoreboard frames to train a smaller vision model later

Off by default. Your camera footage is not my dataset unless you say so.

**Tweet 7 (close)**

I'm a CS student who builds AI bots that do real work. This one turns the game you're already watching into the input.

2022 World Cup Final. UFC 229. Tiger at the 2019 Masters. All replayable, all labeled honest.

Look at the game. See the probability.

ReLoop. 🌸⚔️

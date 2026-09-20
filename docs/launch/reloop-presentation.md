# LOS / Loop OS — slide deck creation brief

## Instructions for ChatGPT

Create a polished, editable presentation from this brief for a hackathon judging
session. Deliver the actual slide deck if your tools support it, preferably as a
PowerPoint file, plus speaker notes. Otherwise provide complete slide layouts and
notes ready to transfer into presentation software.

The presentation is **5–7 minutes**, targeting **6 minutes including a live demo**.
The project is **LOS / Loop OS**, pronounced “Loop OS.” ReLoop is an internal
repository name; use LOS / Loop OS on the slides.

Use the eight-slide sequence below. Keep slide text short and put the spoken
script in speaker notes. Make slides visually clear from a distance. Do not turn
these paragraphs into walls of text. Do not ask questions before making the first
draft: use the supplied content and labeled placeholders where assets are missing.

### Visual direction

- Clean, confident, practical technology aesthetic: warm off-white, charcoal,
  and one green accent suggesting reuse.
- Large typography, generous spacing, simple diagrams, and consistent alignment.
- Favor real product screenshots and hardware photos over decorative imagery.
- If no assets are attached, create clearly labeled image placeholders. Do not
  invent dashboard screenshots, Shopify results, product prices, or robot photos.
- Avoid fake statistics, fabricated testimonials, unverified sponsor badges, and
  imagery that implies the robot physically picks up objects.
- Include one architecture diagram and one workflow diagram, made from editable shapes.
- Keep the deck focused on the working prototype; distinguish future ideas.

## Product facts and claim boundaries

Loop OS helps people move from seeing unused belongings to reviewing resale
options and approving listings.

**Working capture paths:** Meta Ray-Ban glasses through an iPhone companion, and
Unitree Go2 robot images through Dimensional's DimOS. Both feed the shared backend
analysis and review workflow. Glasses capture and robot navigation-to-scan-to-
pricing have been demonstrated end to end by the team.

**Robot behavior today:** An operator selects a named, previously saved viewpoint
such as table or sponsor. DimOS navigates there. Our application checks fresh
position data, arrival position, and viewing direction before taking a photo.
The robot does not discover unknown tables from speech, freely inventory an
unfamiliar room, or pick up objects. The current prototype runs DimOS and the
application services on a Mac; AI inference is remote.

**Identification and pricing:** Gemini identifies up to eight visible items in a
scan and suggests estimated secondhand prices with a stated basis. Search
references may be returned, but prices are not guaranteed to be grounded in
completed-sale evidence. Do not call them verified market prices. A photo cannot
prove an object's exact variant, hidden contents, or working condition.

**Review and commerce:** Users can set a target, review a plan, choose what to
keep or sell, and approve publication. Routing can propose donation or recycling;
it does not arrange or complete those handoffs. Shopify publishing is integrated.
The team reports successful storefront listings; use an actual product or
screenshot to demonstrate that result. Facebook Marketplace integration prepares
listing drafts through a browser agent; do not claim automatic publication there.

**Evidence and impact:** Do not invent measured accuracy, latency, users, revenue,
completed purchases, avoided emissions, or waste reduction. Say “one final
approval before publishing,” not “one tap does everything.” The user still makes
review and selection decisions. Analysis is not instantaneous.

## Slide 1 — The five-minute task you never start

**Time:** 0:00–0:40

**On-slide copy:**

LOS / Loop OS

**A five-minute task. Forty minutes to start.**

Give your things a second life.

**Visual:** One unused monitor or game console, preferably a real demo object.
Treat the five/forty-minute phrase as a relatable hook, not a research statistic.

**Speaker notes:**

“You know that thing sitting in the corner that you've been meaning to sell for
three months? Taking a photo takes a minute. Looking up a price takes a few more.
But somehow, starting the whole process feels like a project.

“Sometimes it's a five-minute task that takes forty minutes to start. We built
LOS—Loop OS—to make that first step easier. We started with the unused stuff
around us.”

## Slide 2 — Selling is a series of chores

**Time:** 0:40–1:15

**On-slide copy:**

**Usable things get stuck behind unfinished tasks.**

Photograph → Identify → Research → Write → List

**Loop OS connects the steps. You make the decisions.**

**Visual:** A simple before/after workflow. Above: separate chores. Below:
capture → review → approve. Do not imply the review stage disappears.

**Speaker notes:**

“A working monitor can sit unused because selling it means doing several small
jobs: photographing it, figuring out what it is worth, writing a description,
and creating a listing.

“We wanted to connect those steps. Loop OS turns a camera view into identified
items, estimated resale values, and a plan the owner can review. You choose what
to keep and approve what gets listed.”

## Slide 3 — Wear the camera. Or send it.

**Time:** 1:15–2:00

**On-slide copy:**

**Two cameras. One workflow.**

Meta glasses + iPhone → Loop OS ← Unitree Go2 + DimOS

Identify · Estimate · Review · Approve

**Visual:** Two hardware photos or labeled placeholders, merging into one actual
dashboard screenshot or placeholder.

**Speaker notes:**

“Our first capture source is Meta glasses through our iPhone companion. We capture
what we see, and Loop OS identifies visible objects and suggests estimated prices.
We can review up to eight items from one scan.

“Then we connected a robot dog to the same workflow. If you're walking around,
wear the camera. If you're operating remotely, send the camera to a saved viewpoint.
The downstream analysis and review experience is the same.”

**Demo cue:** Briefly show the glasses capture and its item results. If showing a
previous scan, call it an earlier scan from this build. Avoid spending the whole
presentation waiting for two separate inference cycles.

## Slide 4 — Live: from a saved viewpoint to a listing

**Time:** 2:00–3:40, including movement and analysis

**On-slide copy:**

**Choose a destination. Review what it sees.**

1. Navigate to table or sponsor
2. Stop and capture
3. Review estimated values
4. Keep or sell
5. Approve the listing

**Visual:** A minimal progress strip. Switch to the real dashboard for the demo.
Keep this slide available as the explanation while the robot moves.

**Speaker notes — start the mission:**

“We've saved two viewpoints in the map: table and sponsor. I'll choose one and
press Go and scan. These are locations we've taught the robot, including where
to face.”

**Demo cue:** Start one short, rehearsed mission. A teammate monitors the clear
route and stop control. Nobody drives by keyboard at the same time.

**Speaker notes — while it moves:**

“DimOS handles mapping and navigation. Our application coordinates the sequence:
wait for arrival, verify position and viewing direction, then capture a fresh
image and send it for analysis. The robot is another camera source, so adding it
reuses the same pricing and review workflow.”

**Speaker notes — when results appear:**

“Here is its actual scan. These are estimated prices, so we review the item and
value before using them. I'll keep this item and select this one to sell.
We review the plan and give final approval before publication.”

**Demo cue:** Use team-owned items. Show the actual Shopify result if publication
succeeds. Avoid accidentally creating duplicate listings during rehearsals.

**Choose the accurate result line:**

- New product succeeded: “Here is the product we just created in Shopify.”
- Earlier successful product: “Here is a product from our earlier end-to-end test.”
- Draft only: “Here is the prepared listing and its approval step.”

If mentioning Facebook: “We also prepare Facebook Marketplace listing drafts.”
Do not describe a draft as a published listing or a listing as a completed sale.

## Slide 5 — How we built the loop

**Time:** 3:40–4:25

**On-slide copy:**

**Shared analysis. Explicit approval.**

Capture → Node.js backend → Gemini → Review & plan → Approval → Shopify

Side branch after review: Facebook Marketplace draft

Robot coordination: Python + DimOS
Glasses capture: SwiftUI + Meta DAT

**Visual:** Editable architecture diagram. Draw the glasses and robot as distinct
inputs. Show the robot navigation step upstream of image capture. Mark the human
review and approval stage clearly. Do not imply the Gemini model controls motion
or authorizes publication.

**Speaker notes:**

“Our SwiftUI companion uses Meta's Device Access Toolkit for glasses capture.
A Node.js backend connects incoming images, Gemini analysis, the dashboard, and
the listing workflow. Python scripts connect our robot missions to DimOS.

“Gemini handles the uncertain part: identifying objects and suggesting values.
Code validates the response and applies the workflow rules. The owner decides
what gets listed. Shopify handles the storefront integration, while the Facebook
path prepares a Marketplace draft.”

## Slide 6 — The hardest bugs reported success

**Time:** 4:25–5:05

**On-slide copy:**

**A working preview isn't a working pipeline.**

Camera live ≠ position data ready
Planner idle ≠ arrival failed
Product created ≠ storefront published

**Visual:** Three compact checkpoints, each with an explicit validation step.
Avoid a dense error-log screenshot.

**Speaker notes:**

“Almost every expensive bug this weekend was something cheerfully reporting
success. A camera could stream while robot position updates had stopped. A robot
could finish its turn but briefly report idle before its arrival flag updated.
And a product could be created without being available on the storefront.

“We learned to verify the handoff between stages, rather than treating a successful
request as a successful experience. That led to sensor checks, better arrival
handling, and explicit publication checks.”

## Slide 7 — Built across hardware, AI, and commerce

**Time:** 5:05–5:25

**On-slide copy:**

**One end-to-end team effort.**

[Name] — Glasses & iPhone capture
[Name] — Identification, pricing & robot missions
[Name] — Shopify integration
[Name] — Web app, backend & Marketplace

**Visual:** Four equal role cards. Leave editable placeholders for names; do not
invent people, credentials, or contribution details. Confirm the exact role split
with the team before presenting.

**Speaker notes:**

“We split ownership across capture, identification and pricing, commerce, and the
application. We brought the robot into that shared pipeline and tested the full
flow together. The integration was the project—not just the individual parts.”

## Slide 8 — Give things a second life

**Time:** 5:25–6:00

**On-slide copy:**

**Today: see → review → list.**

Next:
- Stronger sold-price evidence
- Multiple views of each item
- Easier robot destination discovery

**LOS / Loop OS**
Wear the camera. Or send it.

**Visual:** Return to the opening object, now beside a real listing screenshot or
placeholder. Do not depict a purchase or donation that has not occurred.

**Speaker notes:**

“Next, we want better pricing evidence from completed sales, multiple views for
more reliable identification, and robot destinations that are easier to teach
and eventually discover. Donation matching and measuring reuse are further
extensions, not outcomes we're claiming today.

“Resale is our first workflow. The bigger idea is making the things around us
easier to act on—with us deciding what happens.

“LOS—Loop OS. Wear the camera or send it. Choose what to keep, and give the rest
a second life.”

## Timing and live-demo fallback

For **five minutes**, remove slide 7 and shorten the opening, architecture, and
lessons sections. Keep one robot mission.

For **seven minutes**, allow more time for item review and judge interaction. A
second mission is optional only if its full route and analysis have been rehearsed
to fit; do not promise two robot missions within an untested time budget.

If the live connection stalls, say: “The live connection is taking longer than our
slot. Here is a recorded run of this same workflow.” Show a clearly labeled
recording. Never present prerecorded motion or prior analysis as live.

## Assets to include if supplied

- Team's Meta glasses and iPhone capture photo.
- Team's Unitree Go2 robot photo or navigation clip.
- Actual Loop OS scan with estimated prices.
- Keep/sell selection and plan-review screenshot.
- Actual Shopify product from a successful test.
- Team names and confirmed role split.
- Repository or demo QR code only if a valid shareable URL is provided. A localhost
  URL is not publicly accessible.

## Optional appendix: concise judge answers

**Why use a robot?** It gives the same workflow a remotely positioned camera at
saved viewpoints. It does not handle the objects physically.

**Are prices verified?** They are estimates. Returned search references can help,
but completed-sale grounding and accuracy evaluation are future improvements.

**Does it understand any destination?** No. The demo selects named viewpoints
saved in the current map, including a viewing direction.

**Does it sell everything automatically?** No. The owner reviews selections and
approves publication. Facebook Marketplace is a draft-preparation integration.

**What runs where?** The Mac runs the backend and DimOS services, the robot
provides sensors and motion, the iPhone connects the glasses, and Gemini inference
is remote.

**What sustainability impact have you measured?** None yet. Enabling reuse is the
motivation; waste and emissions reductions have not been quantified.

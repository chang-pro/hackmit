# ReLoop — Plume submission draft

These are paste-ready draft sections, not confirmed Plume field names. Match and
shorten them once the actual form, limits, and event requirements are available.

## Project name

ReLoop

## Tagline

Look at your stuff. Choose what gets a second life.

## Short description

ReLoop turns images from Meta glasses or a robot dog into identified items,
estimated resale prices, and a user-approved listing workflow. Send the robot
to a saved viewpoint, scan what's visible, and choose what to keep or sell.

## Inspiration / Problem

Moving out and clearing a room reveal how much usable stuff we leave unused.
Selling it still takes effort: photograph each object, work out what it might be
worth, and create a listing. We built ReLoop to make those first steps easier,
starting from a view of the objects rather than a blank form.

## What it does

ReLoop accepts images from Meta smart glasses or a Unitree Go2 robot camera.
It identifies up to eight visible items per scan and suggests estimated secondhand
values. The user reviews the results and selects what to keep or sell before
approving a listing through our Shopify integration.

The robot adds a remote capture workflow. In the dashboard, an operator chooses a
saved viewpoint such as table or sponsor. DimOS navigates to that location;
ReLoop checks arrival and viewing direction, captures a fresh image, and opens
the same pricing and item-selection experience used for the glasses.

## How we built it

We connected a Swift/SwiftUI iPhone companion and Meta glasses capture to a Node.js
backend and browser dashboard. Gemini handles image-based item identification
and estimated pricing. Our adapter requests Google Search grounding and preserves
returned references, while treating prices as estimates when evidence is absent.

Python scripts connect to the running DimOS session for robot sensor access,
saved viewpoints, navigation, and image capture. The dashboard launches and
tracks these missions through the Node backend. The robot and glasses share
the downstream analysis and item-review workflow. Shopify provides the listing
integration after user approval.

## Challenges

The most interesting challenge was coordinating robot motion with an asynchronous
web application. Camera video could remain available even when position updates
stopped. We added sensor checks and required fresh odometry before navigation.
We also fixed an arrival timing issue: DimOS could report an idle state before
its arrival flag was updated, causing our application to cancel a successful
mission. The application now allows that handoff and separately verifies the
arrival position and viewing direction before scanning.

Pricing introduced a different uncertainty: seeing an object does not prove its
exact model, contents, or working condition. Our workflow presents estimated
values for user review rather than treating a model's output as a verified sale
price.

## Accomplishments

We demonstrated the glasses capture workflow and the robot's navigation-to-scan-
to-pricing workflow end to end. We connected two different physical camera
sources to one item-review experience, added multiple named robot viewpoints,
and integrated user-approved listing preparation with Shopify. The result is a
working physical demonstration of moving from a room view to resale decisions.

## What we learned

The boundary between hardware and software needs explicit states. A visible
camera feed does not prove navigation is ready, and an idle planner does not
always mean a mission failed. We learned to verify sensor freshness, wait for
the right completion signal, and keep human review at the point where an estimate
becomes a listing.

## What's next

We want to evaluate estimated prices against completed-sale evidence, improve
item identification across multiple views, and support richer destination
descriptions. Today, the robot uses named viewpoints saved in the current map;
recognizing and navigating to unfamiliar tables from natural language is a future
extension.

## Built with

JavaScript, Node.js, Python, Swift, SwiftUI, Gemini API, Meta smart glasses,
DimOS, Unitree Go2, Shopify, HTML, CSS.

## Integration descriptions, if the form asks

**Meta:** Smart glasses serve as a wearable image source through the iPhone
companion, feeding ReLoop's item-identification and estimated-pricing workflow.

**Dimensional:** DimOS supplies the robot sensor and navigation interface. ReLoop
adds named viewpoint missions and triggers its scan/review flow after verified
arrival.

**Google / Gemini:** Gemini identifies visible items and produces estimated resale
values. The adapter requests search grounding and retains references when returned.

**Shopify:** Selected items enter a listing workflow that requires user approval
before publication. Include a resulting product screenshot if publication is
demonstrated successfully before submission.

These descriptions establish what we used; they do not establish prize eligibility.
Check the actual event challenge requirements before selecting sponsor tracks.
Do not claim Ramp, Visa, OpenAI, xAI, or public-dataset usage unless the team can
point to the implemented integration or analysis used in this build.

## Still needed for the actual form

- Plume project URL and exact questions/character limits.
- Team name, members, and required profiles.
- Submission repository URL and access requirements.
- Demo video URL and permitted duration.
- Hosted URL if available; localhost is not a public demo link.
- Selected challenge tracks and their current requirements.

## Suggested gallery and video

1. Glasses capture producing a real item-review screen.
2. Robot moving between the two saved viewpoints.
3. A robot scan with estimated prices and keep/sell selection.
4. Approved Shopify product, if successfully published.

Record a concise sequence: capture → items and estimates → choose destination →
robot arrives → fresh scan → keep/sell → approval. Label any recorded fallback.
Exclude terminal credentials and account secrets from screenshots and video.

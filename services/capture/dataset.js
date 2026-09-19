// Vision-model training-data collector (privacy rule README §16).
//
// OFF BY DEFAULT: unless the DATASET_DIR environment variable (or an explicit
// dir option) is set, this class writes NOTHING to disk — raw camera footage
// is never persisted without the operator opting in. When enabled, each
// selector-ACCEPTED live frame is decoded from base64 to a .jpg and saved
// next to the latest reconciled state JSON as a labeled training pair under
// DATASET_DIR/<sport>/. Frames with no reconciled state yet are saved
// unlabeled (image only) — a label is never invented.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_URL_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;

export class DatasetWriter {
  constructor({ dir = process.env.DATASET_DIR || null } = {}) {
    this.dir = dir;
  }

  get enabled() {
    return Boolean(this.dir);
  }

  // Saves one labeled pair. Returns { image, label } file paths (label null
  // when no state was available), or null when the writer is disabled.
  //   sport        — sport id string (subdirectory name)
  //   frame        — §7.1 frame metadata (frame_id names the files)
  //   imageBase64  — the accepted frame's image (raw base64 or data URL)
  //   state        — latest reconciled canonical state for the sport, or null
  async record({ sport = "nba", frame, imageBase64, state = null }) {
    if (!this.enabled) return null;
    if (!frame?.frame_id) throw new Error("dataset writer requires frame.frame_id");
    if (typeof imageBase64 !== "string" || imageBase64 === "") {
      throw new Error("dataset writer requires a non-empty imageBase64");
    }

    const sportDir = join(this.dir, sport);
    await mkdir(sportDir, { recursive: true });

    const imagePath = join(sportDir, `${frame.frame_id}.jpg`);
    const payload = imageBase64.replace(DATA_URL_PREFIX, "");
    await writeFile(imagePath, Buffer.from(payload, "base64"));

    let labelPath = null;
    if (state) {
      labelPath = join(sportDir, `${frame.frame_id}.state.json`);
      await writeFile(
        labelPath,
        JSON.stringify(
          { sport, frame, state, labeled_at: new Date().toISOString() },
          null,
          2
        )
      );
    }
    return { image: imagePath, label: labelPath };
  }
}

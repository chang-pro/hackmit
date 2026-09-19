"""Upload a local photo to the Lane B dev API; no image path goes into the repo."""

import argparse
import base64
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photo", type=Path)
    parser.add_argument("--api", default="http://127.0.0.1:8001")
    parser.add_argument("--source", choices=["PHONE", "GLASSES", "DOG"], default="PHONE")
    parser.add_argument("--spot")
    parser.add_argument("--mission-id")
    parser.add_argument(
        "--existing", type=Path, help="Previous identify response from the same scan/spot"
    )
    parser.add_argument("--out", type=Path, help="Save JSON for your next scan or teammate")
    args = parser.parse_args()
    from reloop_brain.api import decode_image

    try:
        encoded = base64.b64encode(args.photo.read_bytes()).decode()
        decode_image(encoded)
        existing = json.loads(args.existing.read_text())["items"] if args.existing else []
        capture_id = "cap_" + uuid4().hex[:16]
        payload = {
            "capture": {
                "id": capture_id,
                "ts": datetime.now(UTC).isoformat(),
                "source": args.source,
                "uri": f"blob://{capture_id}",
                "spot": args.spot,
                "missionId": args.mission_id,
            },
            "imageBase64": encoded,
            "existingItems": existing,
        }
        request = Request(
            args.api.rstrip("/") + "/identify",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=120) as response:
            result = json.dumps(json.load(response), indent=2) + "\n"
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(result)
        print(result, end="")
    except HTTPError as exc:
        print(f"HTTP {exc.code}: {exc.read().decode()}", file=sys.stderr)
        raise SystemExit(1) from exc
    except (OSError, ValueError, KeyError, URLError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()

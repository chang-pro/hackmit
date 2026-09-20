"""Capture one frame from an existing dimOS run and open ReLoop's item picker.
Run with the dimOS virtualenv Python. This script sends no movement commands.
"""
import argparse
from datetime import datetime, timezone
import time
import webbrowser

import requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', default='http://127.0.0.1:3000')
    parser.add_argument('--image', help='Test with a saved image instead of the robot')
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    base = args.backend.rstrip('/')
    requests.get(base + '/api/health', timeout=5).raise_for_status()
    if args.image:
        import base64
        from io import BytesIO
        from PIL import Image
        with Image.open(args.image) as image:
            width, height = image.size
            buffer = BytesIO()
            image.convert("RGB").save(buffer, format="JPEG", quality=85)
            encoded = base64.b64encode(buffer.getvalue()).decode()
    else:
        from dimos import Dimos
        app = Dimos.connect()
        try:
            image = app.peek_stream('color_image', 5.0)
            if image is None:
                raise RuntimeError('No camera frame received. Check the dimOS camera feed.')
            width, height = image.width, image.height
            encoded = image.to_base64()
        finally:
            app.stop()  # Remote client disconnect only; leaves robot session running.
    response = requests.post(base + '/api/frames', json={
        'source': 'robot_snapshot', 'captured_at': datetime.now(timezone.utc).isoformat(),
        'image_base64': encoded, 'mime_type': 'image/jpeg',
        'width': width, 'height': height, 'force_analysis': True,
    }, timeout=90)
    response.raise_for_status()
    result = response.json()
    frame_id = result['frame']['frame_id']
    print('Snapshot submitted. Waiting for pricing…', flush=True)
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        response = requests.get(base + '/api/items/latest', timeout=5)
        data = response.json()
        photo = data.get('photo')
        if photo and photo.get('frame_id') == frame_id:
            url = base + '/live?photo=' + photo['photo_id']
            print(f"Found {len(photo['items'])} items. Choose what to keep or sell:\n{url}")
            if not args.no_open:
                webbrowser.open(url)
            return
        if data.get('queue', {}).get('last_error'):
            raise RuntimeError(data['queue']['last_error'])
        time.sleep(1)
    raise TimeoutError('Pricing did not finish within 150 seconds; check the backend.')


if __name__ == '__main__':
    main()

import argparse
import json
import os
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps
from rembg import new_session, remove


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def list_images(input_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in input_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A")
    return alpha.getbbox()


def fit_on_canvas(
    cutout: Image.Image,
    canvas_width: int,
    canvas_height: int,
    padding_ratio: float,
    background: tuple[int, int, int, int],
) -> Image.Image:
    bbox = alpha_bbox(cutout)
    if bbox is None:
        return Image.new("RGBA", (canvas_width, canvas_height), background)

    cropped = cutout.crop(bbox)
    max_width = int(canvas_width * (1 - padding_ratio * 2))
    max_height = int(canvas_height * (1 - padding_ratio * 2))

    fitted = ImageOps.contain(cropped, (max_width, max_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (canvas_width, canvas_height), background)
    x = (canvas_width - fitted.width) // 2
    y = (canvas_height - fitted.height) // 2
    canvas.alpha_composite(fitted, (x, y))
    return canvas


def process_image(
    image_path: Path,
    output_dir: Path,
    session,
    canvas_width: int,
    canvas_height: int,
    padding_ratio: float,
) -> dict:
    started = time.perf_counter()
    with Image.open(image_path) as image:
        image = ImageOps.exif_transpose(image).convert("RGBA")
        cutout = remove(image, session=session)

    transparent = fit_on_canvas(
        cutout,
        canvas_width,
        canvas_height,
        padding_ratio,
        (0, 0, 0, 0),
    )
    preview = fit_on_canvas(
        cutout,
        canvas_width,
        canvas_height,
        padding_ratio,
        (246, 246, 242, 255),
    ).convert("RGB")

    transparent_path = output_dir / f"{image_path.stem}.u2net.transparent.png"
    preview_path = output_dir / f"{image_path.stem}.u2net.preview.jpg"
    transparent.save(transparent_path)
    preview.save(preview_path, quality=92, optimize=True)

    bbox = alpha_bbox(transparent)
    foreground_ratio = 0
    if bbox is not None:
        foreground_ratio = round(((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / (canvas_width * canvas_height), 4)

    return {
        "source": str(image_path),
        "transparent": str(transparent_path),
        "preview": str(preview_path),
        "model": "u2net",
        "canvas": {"width": canvas_width, "height": canvas_height},
        "foregroundRatio": foreground_ratio,
        "elapsedSeconds": round(time.perf_counter() - started, 2),
    }


def fit_rgb_preview(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    preview = Image.new("RGB", size, (246, 246, 242))
    image = ImageOps.exif_transpose(image).convert("RGB")
    fitted = ImageOps.contain(image, size, Image.Resampling.LANCZOS)
    x = (size[0] - fitted.width) // 2
    y = (size[1] - fitted.height) // 2
    preview.paste(fitted, (x, y))
    return preview


def make_contact_sheet(results: list[dict], output_dir: Path) -> str:
    cell_width = 260
    cell_height = 325
    label_height = 28
    gutter = 18
    row_height = cell_height + label_height + gutter
    sheet_width = cell_width * 2 + gutter * 3
    sheet_height = row_height * len(results) + gutter
    sheet = Image.new("RGB", (sheet_width, sheet_height), (238, 238, 232))
    draw = ImageDraw.Draw(sheet)

    for index, item in enumerate(results, start=1):
        y = gutter + (index - 1) * row_height
        source_path = Path(item["source"])
        preview_path = Path(item["preview"])
        with Image.open(source_path) as source_image:
            source_preview = fit_rgb_preview(source_image, (cell_width, cell_height))
        with Image.open(preview_path) as processed_image:
            processed_preview = fit_rgb_preview(processed_image, (cell_width, cell_height))

        left_x = gutter
        right_x = gutter * 2 + cell_width
        sheet.paste(source_preview, (left_x, y + label_height))
        sheet.paste(processed_preview, (right_x, y + label_height))
        draw.text((left_x, y), f"{index:02d} original", fill=(35, 35, 35))
        draw.text((right_x, y), f"{index:02d} u2net", fill=(35, 35, 35))

    sheet_path = output_dir / "comparison.u2net.jpg"
    sheet.save(sheet_path, quality=92, optimize=True)
    return str(sheet_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate U2-Net closet item cutout thumbnails.")
    parser.add_argument("--input", default="resources/closet")
    parser.add_argument("--output", default="resources/closet-bg-test-u2net")
    parser.add_argument("--limit", type=int, default=0, help="0 means all images.")
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--padding", type=float, default=0.1)
    args = parser.parse_args()

    input_dir = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    images = list_images(input_dir)
    if args.limit > 0:
        images = images[: args.limit]

    session = new_session("u2net")
    results = [
        process_image(
            image,
            output_dir,
            session,
            args.width,
            args.height,
            args.padding,
        )
        for image in images
    ]
    comparison_path = make_contact_sheet(results, output_dir) if results else None

    summary_path = output_dir / "summary.json"
    summary_path.write_text(
        json.dumps(
            {
                "model": "u2net",
                "cwd": os.getcwd(),
                "count": len(results),
                "comparison": comparison_path,
                "items": results,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"count": len(results), "summary": str(summary_path), "comparison": comparison_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()

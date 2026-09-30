import io
import random
import unittest

from PIL import Image

from screencap import frames


def noise(size=(200, 120), seed=1) -> Image.Image:
    rng = random.Random(seed)
    image = Image.new("RGB", size)
    image.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(size[0] * size[1])])
    return image


class BlackDetection(unittest.TestCase):
    def check(self, image, threshold=10.0) -> bool:
        return frames.is_black(frames.brightness(image), threshold)

    def test_a_black_picture_is_black(self):
        self.assertTrue(self.check(Image.new("RGB", (640, 360), (0, 0, 0))))

    def test_a_very_dark_picture_is_black_with_the_default_threshold(self):
        self.assertTrue(self.check(Image.new("RGB", (640, 360), (5, 5, 5))))

    def test_a_dim_but_real_picture_is_not(self):
        self.assertFalse(self.check(Image.new("RGB", (640, 360), (25, 25, 25))))

    def test_a_black_window_with_a_cursor_sized_bright_spot_is_still_black(self):
        image = Image.new("RGB", (640, 360), (0, 0, 0))
        image.paste((255, 255, 255), (300, 200, 306, 206))  # a thumbnail cell is 20x20 pixels here
        self.assertTrue(self.check(image))

    def test_a_black_window_with_a_bright_hud_is_not_black(self):
        image = Image.new("RGB", (640, 360), (0, 0, 0))
        image.paste((255, 255, 255), (20, 20, 60, 40))  # 40x20: two cells of the thumbnail are lit
        self.assertFalse(self.check(image))

    def test_a_mostly_black_picture_with_a_large_bright_area_is_not_black(self):
        image = Image.new("RGB", (640, 360), (0, 0, 0))
        image.paste((255, 255, 255), (0, 0, 320, 180))  # a quarter of it
        self.assertFalse(self.check(image))

    def test_the_threshold_moves_the_line_and_zero_turns_the_check_off(self):
        gray = Image.new("RGB", (64, 36), (30, 30, 30))
        self.assertFalse(self.check(gray, 10))
        self.assertTrue(self.check(gray, 40))
        self.assertFalse(self.check(Image.new("RGB", (64, 36), (0, 0, 0)), 0))

    def test_brightness_is_the_mean_and_the_brightest_cell_of_the_thumbnail(self):
        measured = frames.brightness(Image.new("RGB", (640, 360), (100, 100, 100)))
        self.assertAlmostEqual(measured.mean, 100, delta=1)
        self.assertAlmostEqual(measured.peak, 100, delta=1)


class Resizing(unittest.TestCase):
    def test_shrinks_to_the_width_and_keeps_the_shape(self):
        out = frames.fit_width(Image.new("RGB", (1920, 1080)), 768)
        self.assertEqual(out.size, (768, 432))

    def test_never_enlarges(self):
        self.assertEqual(frames.fit_width(Image.new("RGB", (500, 300)), 768).size, (500, 300))

    def test_zero_keeps_the_size(self):
        self.assertEqual(frames.fit_width(Image.new("RGB", (1920, 1080)), 0).size, (1920, 1080))

    def test_a_very_wide_thin_window_keeps_at_least_one_row(self):
        self.assertEqual(frames.fit_width(Image.new("RGB", (4000, 2)), 100).size, (100, 1))


class Encoding(unittest.TestCase):
    def test_the_result_is_a_jpeg_that_decodes_to_the_same_size(self):
        data = frames.encode_jpeg(noise(), 80)
        self.assertEqual(data[:3], b"\xff\xd8\xff")
        decoded = Image.open(io.BytesIO(data))
        self.assertEqual((decoded.format, decoded.size), ("JPEG", (200, 120)))

    def test_a_higher_quality_makes_a_bigger_file(self):
        image = noise()
        self.assertGreater(len(frames.encode_jpeg(image, 90)), len(frames.encode_jpeg(image, 30)))

    def test_an_image_with_an_alpha_channel_is_flattened(self):
        rgba = Image.new("RGBA", (40, 40), (255, 0, 0, 128))
        Image.open(io.BytesIO(frames.encode_jpeg(rgba, 80))).load()


class Prepare(unittest.TestCase):
    def test_reports_both_sizes_the_brightness_and_the_flag(self):
        frame = frames.prepare(
            Image.new("RGB", (1600, 900), (0, 0, 0)), max_width=800, quality=80, black_threshold=10
        )
        self.assertEqual((frame.source_width, frame.source_height), (1600, 900))
        self.assertEqual((frame.width, frame.height), (800, 450))
        self.assertTrue(frame.black)
        self.assertEqual(frame.brightness, 0)
        decoded = Image.open(io.BytesIO(frame.jpeg))
        self.assertEqual(decoded.size, (800, 450))

    def test_a_lit_picture_is_not_black(self):
        frame = frames.prepare(noise(), max_width=768, quality=80, black_threshold=10)
        self.assertFalse(frame.black)
        self.assertGreater(frame.brightness, 100)


if __name__ == "__main__":
    unittest.main()

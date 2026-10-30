"""Keep schema-5 heart positions while accepting schema-6 force samples."""
import unittest
from flitfancy_sensors import parse_sensor_csv_line, normalize_sensor_row, sensor_row_public


class PressureProtocolTest(unittest.TestCase):
    def frame(self, channel, extra=()):
        fields = ["12345", "8", str(channel), f"CH{channel} SENSOR", "1"]
        fields += ["NA"] * 23
        fields += ["12", "42", "0", "0.3.0", "6", "independent-v1", "NA", "-60"]
        fields += ["78", "1", "1", "streaming"] if channel == 6 else ["NA"] * 4
        return "CSV," + ",".join([*fields, *extra])

    def test_force_preserves_signed_raw_and_units(self):
        row = normalize_sensor_row(parse_sensor_csv_line(self.frame(7, ["-950", "-7.421875", "0"])))
        public = sensor_row_public(row)
        self.assertEqual(public["force_raw"], -950)
        self.assertEqual(public["force_mv"], -7.421875)
        self.assertEqual(public["force_saturated"], 0)
        self.assertIsNone(public["pressure_pa"])

    def test_zero_is_valid(self):
        row = sensor_row_public(normalize_sensor_row(parse_sensor_csv_line(self.frame(7, ["0", "0", "0"]))))
        self.assertEqual(row["force_raw"], 0)
        self.assertEqual(row["force_mv"], 0)

    def test_old_heart_and_extended_heart_preserve_positions(self):
        for extra in ((), ("NA", "NA", "NA")):
            row = sensor_row_public(normalize_sensor_row(parse_sensor_csv_line(self.frame(6, extra))))
            self.assertEqual(row["heart_rate_bpm"], 78)
            self.assertEqual(row["hr_connected"], 1)
            self.assertEqual(row["hr_state"], "streaming")
            self.assertEqual(row["sample_seq"], 42)
            self.assertEqual(row["firmware_version"], "0.3.0")
            self.assertTrue("force_raw" not in row or row["force_raw"] is None)


if __name__ == "__main__":
    unittest.main()

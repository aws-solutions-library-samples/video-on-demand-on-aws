######################################################################################################################
#  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           #
#                                                                                                                    #
#  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    #
#  with the License. A copy of the License is located at                                                             #
#                                                                                                                    #
#      http://www.apache.org/licenses/LICENSE-2.0                                                                    #
#                                                                                                                    #
#  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES #
#  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    #
#  and limitations under the License.                                                                                #
######################################################################################################################

import unittest
import lambda_function as function

class TestParser(unittest.TestCase):
    def test_parse_string(self):
        self.assertEqual(function.parse_number('42'), 42)

    def test_parse_int(self):
        self.assertEqual(function.parse_number(42), 42)

    def test_parse_float(self):
        self.assertEqual(function.parse_number(42.0), 42.0)

    def test_parse_repeated_values(self):
        self.assertEqual(function.parse_number('128000 / 128000'), 128000)

    def test_parse_throws_when_repeated_values_conflict(self):
        with self.assertRaises(ValueError):
            function.parse_number('128000 / 129000')

    def test_parse_throws_when_number_is_invalid(self):
        with self.assertRaises(ValueError):
            function.parse_number('bogus')

    def test_parse_general_attributes(self):
        track = {
            'Format': 'MPEG-4',
            'FileSize': 8000000,
            'Duration': 21021,
            'OverallBitRate': 800
        }

        expected = {
            'format': 'MPEG-4',
            'fileSize': 8000000,
            'duration': 21021,
            'totalBitrate': 800
        }

        self.assertEqual(function.parse_general_attributes(track), expected)

    def test_parse_video_attributes(self):
        track = {
            'Format': 'AVC',
            'Format_Profile': 'High',
            'Format_Level': '4',
            'BitRate': '8000000',
            'Duration': '21021',
            'FrameCount': '630',
            'Width': '1920',
            'Height': '1080',
            'FrameRate': '29.970',
            'ScanType': 'Progressive',
            'DisplayAspectRatio': '1.778',
            'BitDepth': '8',
            'ColorSpace': 'YUV',
            'ChromaSubsampling': '4:2:0'
        }

        expected = {
            'codec': 'AVC',
            'profile': 'High@L4',
            'bitrate': 8000000,
            'duration': 21021,
            'frameCount': 630,
            'width': 1920,
            'height': 1080,
            'framerate': 29.97,
            'scanType': 'Progressive',
            'aspectRatio': '1.778',
            'bitDepth': 8,
            'colorSpace': 'YUV 4:2:0'
        }

        self.assertEqual(function.parse_video_attributes(track), expected)

    def test_parse_audio_attributes(self):
        track = {
            'Format': 'AAC',
            'BitRate': '384000',
            'Duration': '21013',
            'FrameCount': '630',
            'BitRate_Mode': 'VBR',
            'Channels': '2',
            'SamplingRate': '48000',
            'SamplesPerFrame': '1024'
        }

        expected = {
            'codec': 'AAC',
            'bitrate': 384000,
            'duration': 21013,
            'frameCount': 630,
            'bitrateMode': 'VBR',
            'channels': 2,
            'samplingRate': 48000,
            'samplePerFrame': 1024
        }

        self.assertEqual(function.parse_audio_attributes(track), expected)

    def test_parse_text_attributes(self):
        track = {
            'ID': '1',
            'Format': 'TXT',
            'Duration': 1000,
            'Count': 21021,
            'CaptionServiceName': 500
        }

        expected = {
            'id': '1',
            'format': 'TXT',
            'duration': 1000,
            'frameCount': 21021,
            'captionServiceName': 500
        }

        self.assertEqual(function.parse_text_attributes(track), expected)

if __name__ == '__main__':
    unittest.main()

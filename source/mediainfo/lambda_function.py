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

import boto3
import json
import os
import re
import subprocess
from botocore.config import Config

def parse_number(num):
    if num is None:
        return None

    if isinstance(num, str) and ' / ' in num:
        values = [value.strip() for value in num.split(' / ')]
        if any(value != values[0] for value in values[1:]):
            raise ValueError(f'Conflicting numeric values: {num}')
        num = values[0]

    try:
        return int(num)
    except ValueError:
        return float(num)

def compact(attributes):
    return { k: v for k, v in attributes.items() if v is not None }

def parse_common_attributes(track):
    attributes = {}

    attributes['codec'] = track.get('Format')

    level = track.get('Format_Level')
    profile_values = [
        track.get('Format_Profile'),
        None if level is None else 'L' + level,
        track.get('Format_Tier')
    ]

    profile = '@'.join([i for i in profile_values if i is not None])
    if profile != '':
        attributes['profile'] = profile

    attributes['bitrate'] = parse_number(track.get('BitRate'))
    attributes['duration'] = parse_number(track.get('Duration'))
    attributes['frameCount'] = parse_number(track.get('FrameCount'))

    return attributes

def parse_general_attributes(track):
    attributes = {}

    attributes['format'] = track.get('Format')
    attributes['fileSize'] = parse_number(track.get('FileSize'))
    attributes['duration'] = parse_number(track.get('Duration'))
    attributes['totalBitrate'] = parse_number(track.get('OverallBitRate'))

    return compact(attributes)

def parse_video_attributes(track):
    attributes = parse_common_attributes(track)

    attributes['width'] = parse_number(track.get('Width'))
    attributes['height'] = parse_number(track.get('Height'))
    attributes['framerate'] = parse_number(track.get('FrameRate'))
    attributes['scanType'] = track.get('ScanType')
    attributes['aspectRatio'] = track.get('DisplayAspectRatio')

    attributes['bitDepth'] = parse_number(track.get('BitDepth'))
    attributes['colorSpace'] = '{0} {1}'.format(track.get('ColorSpace'), track.get('ChromaSubsampling'))

    return compact(attributes)

def parse_audio_attributes(track):
    attributes = parse_common_attributes(track)

    attributes['bitrateMode'] = track.get('BitRate_Mode')
    attributes['language'] = track.get('Language')
    attributes['channels'] = parse_number(track.get('Channels'))
    attributes['samplingRate'] = parse_number(track.get('SamplingRate'))
    attributes['samplePerFrame'] = parse_number(track.get('SamplesPerFrame'))

    return compact(attributes)

def parse_text_attributes(track):
    attributes = {}

    attributes['id'] = track.get('ID')
    attributes['format'] = track.get('Format')
    attributes['duration'] = parse_number(track.get('Duration'))
    attributes['frameCount'] = parse_number(track.get('Count'))
    attributes['captionServiceName'] = parse_number(track.get('CaptionServiceName'))

    return compact(attributes)

def get_signed_url(bucket, obj):
    SIGNED_URL_EXPIRATION = 60 * 60 * 2
    AWS_REGION = os.environ['AWS_REGION']
    boto_config = Config(
        region_name=AWS_REGION,
        s3={
            'addressing_style': 'path'
        }
    )
    s3_client = boto3.client('s3', config=boto_config)
    return s3_client.generate_presigned_url(
        'get_object',
        Params={ 'Bucket': bucket, 'Key': obj },
        ExpiresIn=SIGNED_URL_EXPIRATION
    )

def lambda_handler(event, _):
    print(f'REQUEST:: {json.dumps(event)}')

    try:
        metadata = {}
        metadata['filename'] = event['srcVideo']

        dir_path = os.path.dirname(os.path.realpath(__file__))
        executable_path = os.path.join(dir_path, 'bin', 'mediainfo')

        signed_url = get_signed_url(event['srcBucket'], event['srcVideo'])
        json_content = json.loads(subprocess.check_output([executable_path, '--Output=JSON', signed_url]))
        print(f'MEDIAINFO OUTPUT:: {json.dumps(json_content)}')

        tracks = json_content['media']['track']
        for track in tracks:
            track_type = track['@type']
            if (track_type == 'General'):
                metadata['container'] = parse_general_attributes(track)
            elif (track_type == 'Video'):
                metadata.setdefault('video', []).append(parse_video_attributes(track))
            elif (track_type == 'Audio'):
                metadata.setdefault('audio', []).append(parse_audio_attributes(track))
            elif (track_type == 'Text'):
                metadata.setdefault('text', []).append(parse_text_attributes(track))
            else:
                print(f'Unsupported: {track_type}')

        event['srcMediainfo'] = json.dumps(metadata, indent=2)
        print(f'RESPONSE:: {json.dumps(metadata)}')

        return event
    except Exception as err:
        payload = {
            'guid': event['guid'],
            'event': event,
            'function': os.environ.get('AWS_LAMBDA_FUNCTION_NAME'),
            'error': str(err)
        }

        lambda_cli = boto3.client('lambda')
        lambda_cli.invoke(
            FunctionName=os.environ.get('ErrorHandler'),
            InvocationType='RequestResponse',
            Payload=json.dumps(payload)
        )

        raise err

#!/usr/bin/env python3
"""Model-free tests with realistic raw traces; no native transcript content."""
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('collect.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class TimingTest(unittest.TestCase):
    def test_nested_spans_clipping_unknown_and_privacy(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            entries = [
                {'timestamp':'2026-10-01T00:00:00Z', 'type':'response_item', 'payload':{'type':'function_call','call_id':'before-window','name':'exec_command'}},
                {'timestamp':'2026-10-01T00:00:00Z', 'type':'response_item', 'payload':{'type':'function_call','call_id':'c1','name':'exec_command','arguments':'SECRET command'}},
                {'timestamp':'2026-10-01T00:00:02Z', 'type':'event_msg', 'payload':{'type':'item_completed','item':{'id':'i1','type':'Reasoning','text':'SECRET hidden reasoning'},'started_at_ms':1790812801000,'completed_at_ms':1790812802000}},
                {'timestamp':'2026-10-01T00:00:03Z', 'type':'response_item', 'payload':{'type':'function_call','call_id':'w1','name':'wait','arguments':'SECRET'}},
                {'timestamp':'2026-10-01T00:00:06Z', 'type':'response_item', 'payload':{'type':'function_call_output','call_id':'w1','output':'SECRET log'}},
                {'timestamp':'2026-10-01T00:00:08Z', 'type':'response_item', 'payload':{'type':'function_call_output','call_id':'c1','output':'SECRET result'}},
                {'timestamp':'2026-10-01T00:00:09Z', 'type':'response_item', 'payload':{'type':'function_call','call_id':'missing','name':'exec_command'}},
            ]
            (base/'trace.jsonl').write_text('\n'.join(json.dumps(e) for e in entries)+'\n')
            (base/'timing.json').write_text(json.dumps({'phases':[{'startedUtc':'2026-10-01T00:00:02Z','seconds':3,'exitCode':0,'command':['node','SECRET private source']}]}))
            manifest = {'startUtc':'2026-10-01T00:00:01Z','endUtc':'2026-10-01T00:00:10Z','agents':[{'id':'/root','traces':['trace.jsonl'],'timings':[{'path':'timing.json','labels':{'0':'Build'}}]}],'markers':[{'label':'PASS','atUtc':'2026-10-01T00:00:08Z'}]}
            data = collector.collect(manifest, base)
            self.assertNotIn('SECRET', json.dumps(data))
            self.assertEqual(data['unionSeconds']['/root'], {'output-item':1, 'tool':7, 'wait':3, 'subprocess':3, 'routing':0, 'unknown':2})
            self.assertEqual(data['coverage'][0]['unmatchedToolRequests'], 1)
            self.assertEqual(data['coverage'][0]['unmatchedPreWindowToolRequests'], 1)
            self.assertEqual(data['markers'][0]['at'], 7)
            self.assertIsNone(next(r for r in data['intervals'] if r['kind']=='subprocess')['networkSeconds'])
            # Matching result after window end still proves the clipped tool span.
            manifest['endUtc'] = '2026-10-01T00:00:04Z'
            clipped = collector.collect(manifest | {'markers':[]}, base)
            self.assertEqual(clipped['unionSeconds']['/root']['tool'], 3)
            self.assertEqual(clipped['unionSeconds']['/root']['unknown'], 0)

    def test_invalid_input_fails_without_dropping_it(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            manifest = {'startUtc':'2026-10-01T00:00:01Z','endUtc':'2026-10-01T00:00:10Z','agents':[{'id':'/root','traces':['trace.jsonl']}]}
            (base/'trace.jsonl').write_text('not json\n')
            with self.assertRaises(json.JSONDecodeError):
                collector.collect(manifest, base)
            with self.assertRaises(ValueError):
                collector.timestamp('2026-10-01T00:00:01')
            manifest['agents'] = [{'id':'child','parent':'absent'}]
            with self.assertRaises(ValueError):
                collector.collect(manifest, base)


if __name__ == '__main__':
    unittest.main()

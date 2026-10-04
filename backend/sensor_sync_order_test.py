"""Sync queue ordering stays monotonic across uploads, timezones and completed sends."""
import threading
import time
from flitfancy_sync import LatestSensorSyncQueue

sent=[]
signal=threading.Event()
def sender(rows):
    sent.extend(rows)
    signal.set()
    return True
queue=LatestSensorSyncQueue(lambda:True,sender)
queue.enqueue([{'board':'fixture','channel':'CH6','ts':'2026-10-04T02:00:00.950Z','value':76}])
assert signal.wait(3)
signal.clear()
queue.enqueue([{'board':'fixture','channel':'CH6','ts':'2026-10-04T09:30:00+08:00','value':60}])
time.sleep(0.1)
assert len(sent)==1,'Completed newer snapshots must still block old backfill'
queue.enqueue([{'board':'fixture','channel':'CH6','ts':'2026-10-04T02:00:00.100Z','value':65}])
time.sleep(0.1)
assert len(sent)==1,'Ordering preserves milliseconds'
queue.enqueue([{'board':'fixture','channel':'CH6','ts':'2026-10-04T02:00:01Z','value':77}])
assert signal.wait(3)
assert sent[-1]['value']==77
print('Sensor sync: old backfill, timezone offsets and subsecond ordering passed')

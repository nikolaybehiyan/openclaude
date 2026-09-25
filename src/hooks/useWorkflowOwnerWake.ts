import { useEffect, useRef } from 'react'
import { useAppStateStore } from '../state/AppState.js'
import { createWorkflowOwnerWakeRouter, type WorkflowOwnerWakeRequest } from '../utils/workflowOwnerWake.js'
import { logError } from '../utils/log.js'
import { subscribeToCommandQueue } from '../utils/messageQueueManager.js'

/** Mount once in the interactive REPL, including while its main turn is idle. */
export function useWorkflowOwnerWake(resume: (request: WorkflowOwnerWakeRequest) => Promise<unknown>): void {
  const store = useAppStateStore()
  const resumeRef = useRef(resume)
  resumeRef.current = resume
  useEffect(() => {
    const router = createWorkflowOwnerWakeRouter({
      getAppState: store.getState, setAppState: store.setState,
      resume: request => resumeRef.current(request), onError: logError,
    })
    let scheduled = false
    const wake = () => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; void router.flush() })
    }
    const unsubscribeState = store.subscribe(wake)
    const unsubscribeQueue = subscribeToCommandQueue(wake)
    wake()
    return () => { unsubscribeState(); unsubscribeQueue(); router.dispose() }
  }, [store])
}

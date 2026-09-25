import React from 'react'
import {afterAll,expect,mock,test} from 'bun:test'
import chalk from 'chalk'
import {AppStoreContext} from '../../state/AppState.js'
import type {AppState} from '../../state/AppStateStore.js'
import {createStore} from '../../state/store.js'
import {renderToString} from '../../utils/staticRender.js'
let reducedMotion=false
mock.module('../../hooks/useSettings.js',()=>({useSettings:()=>({prefersReducedMotion:reducedMotion})}))
const {GoalIndicator}=await import('./GoalIndicator.js')
const originalLevel=chalk.level
afterAll(()=>{chalk.level=originalLevel;mock.restore()})
function indicator(active=true){
 const store=createStore({activeGoal:active?{condition:'fixture',setAt:Date.now()-2200,iterations:1,tokensAtStart:0}:undefined} as AppState)
 return <AppStoreContext.Provider value={store}><GoalIndicator /></AppStoreContext.Provider>
}
test('goal indicator renders actual Ink output in plain, truecolor and reduced-motion modes',async()=>{
 for(const [level,reduced] of [[0,false],[3,false],[3,true]] as const){
  chalk.level=level;reducedMotion=reduced
  const output=await renderToString(indicator(),80)
  expect(output).toContain('◎ /goal active (2s)')
 }
 expect(await renderToString(indicator(false),80)).not.toContain('/goal')
})
test('narrow goal indicator remains readable without clipping its label',async()=>{
 chalk.level=0;reducedMotion=true
 const output=await renderToString(indicator(),20)
 expect(output.trim()).toBe('◎ /goal active (2s)')
 for(const line of output.trim().split(String.fromCharCode(10)))expect(line.length).toBeLessThanOrEqual(20)
})

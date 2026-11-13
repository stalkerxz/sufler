import test from 'node:test';
import assert from 'node:assert/strict';
import { ScriptLibrary } from '../src/library.js';
function setup(){const map=new Map();const storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};let now=100;return {storage,tick:()=>now+=31000,library:new ScriptLibrary(storage,{title:'Первый',text:'Исходный'},()=>now)};}
test('library migrates current script once and persists selection',()=>{const {storage,library:l}=setup();l.create('Второй','Текст');const restored=new ScriptLibrary(storage,{title:'Старый',text:'Не заменять'});assert.equal(restored.current().title,'Второй');assert.equal(restored.data.scripts.length,2);});
test('revision restoration retains the replaced version',()=>{const {library:l,tick}=setup();l.update('Первый','Редакция');tick();l.update('Первый','Ошибка');l.restore(0);assert.equal(l.current().text,'Исходный');assert.equal(l.current().revisions.at(-1).text,'Ошибка');});
test('archive is reversible and does not erase content',()=>{const {library:l}=setup();const id=l.current().id;l.archive(id);assert.equal(l.current(),undefined);l.recover(id);assert.equal(l.current().text,'Исходный');});
test('history has a fixed bound and storage errors are surfaced',()=>{const {library:l,tick,storage}=setup();for(let i=0;i<20;i++){tick();l.update('Первый',String(i));}assert.equal(l.current().revisions.length,12);storage.setItem=()=>{throw Error('quota')};assert.throws(()=>l.update('Первый','new'),/quota/);});
test('checkpoint protects the latest good text before a paste, even within 30 seconds',()=>{const {library:l}=setup();l.update('Первый','Хороший текст');l.checkpoint();l.update('Первый','Случайная замена');l.restore(l.current().revisions.length-1);assert.equal(l.current().text,'Хороший текст');});

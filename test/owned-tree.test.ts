import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeOwnedTree } from '../tools/cleanup/owned-tree.js'

const roots: string[] = []
function fixture() { const root = mkdtempSync(join(tmpdir(), 'owned-tree-test-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('inventory-bound owned tree cleanup', () => {
  it('deletes nested owned entries and empty directories', () => {
    const root = fixture(); mkdirSync(join(root, 'nested/empty'), { recursive: true }); writeFileSync(join(root, 'nested/file'), 'owned')
    removeOwnedTree(root, tmpdir()); expect(existsSync(root)).toBe(false)
  })
  it('refuses the parent itself and paths outside the allowed boundary', () => {
    const root = fixture(); const other = fixture()
    expect(() => removeOwnedTree(root, root)).toThrow('cleanup_boundary_invalid')
    expect(() => removeOwnedTree(root, other)).toThrow('cleanup_boundary_invalid')
    expect(existsSync(root)).toBe(true)
  })
  it('rejects a junction before deleting any other owned entry', () => {
    const root = fixture(); const outside = fixture(); writeFileSync(join(outside, 'sentinel'), 'outside'); writeFileSync(join(root, 'owned'), 'keep')
    symlinkSync(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => removeOwnedTree(root, tmpdir())).toThrow('cleanup_redirected_tree')
    expect(existsSync(join(root, 'owned'))).toBe(true); expect(existsSync(join(outside, 'sentinel'))).toBe(true)
  })
  it('preserves a hard-linked file whose other name is outside the owned tree', () => {
    const root = fixture(); const outside = fixture(); writeFileSync(join(outside, 'sentinel'), 'outside'); linkSync(join(outside, 'sentinel'), join(root, 'alias'))
    expect(() => removeOwnedTree(root, tmpdir())).toThrow('cleanup_unowned_file_type')
    expect(existsSync(join(root, 'alias'))).toBe(true); expect(existsSync(join(outside, 'sentinel'))).toBe(true)
  })
})

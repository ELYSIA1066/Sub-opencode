import { lstatSync, readdirSync, realpathSync, unlinkSync, rmdirSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Callers must first prove ownership and idle/exit state. Never deletes an unlisted child. */
export function removeOwnedTree(root: string, parent: string): void {
  const absolute = resolve(root)
  const rel = relative(resolve(parent), absolute)
  if (!isAbsolute(root) || root !== absolute || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || realpathSync(absolute) !== absolute) throw new Error('cleanup_boundary_invalid')
  const files: Array<{ path: string; stat: Stats }> = []
  const dirs: Array<{ path: string; stat: Stats }> = []
  const inventory = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('cleanup_redirected_tree')
    if (stat.isDirectory()) {
      dirs.push({ path, stat })
      for (const name of readdirSync(path)) inventory(join(path, name))
    } else {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('cleanup_unowned_file_type')
      files.push({ path, stat })
    }
  }
  inventory(absolute)
  // Build the complete, link-free inventory before changing anything. A concurrent
  // replacement or new child causes failure; directory removal is always nonrecursive.
  for (const item of files) {
    const current = lstatSync(item.path)
    if (!current.isFile() || current.nlink !== 1 || current.ino !== item.stat.ino || current.ctimeMs !== item.stat.ctimeMs
      || current.size !== item.stat.size || realpathSync(item.path) !== item.path) throw new Error('cleanup_tree_changed')
    unlinkSync(item.path)
  }
  for (const item of dirs.reverse()) {
    const current = lstatSync(item.path)
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== item.stat.ino || realpathSync(item.path) !== item.path) throw new Error('cleanup_tree_changed')
    rmdirSync(item.path)
  }
}

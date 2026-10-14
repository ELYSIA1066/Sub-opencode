param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256
)
$ErrorActionPreference = 'Stop'
$sourcePath = [IO.Path]::GetFullPath($Source)
$destinationPath = [IO.Path]::GetFullPath($Destination)
if ([IO.Path]::GetDirectoryName($sourcePath) -ne [IO.Path]::GetDirectoryName($destinationPath)) { throw 'Destination must be in the same directory.' }
if ([IO.File]::Exists($destinationPath)) { throw 'Destination already exists.' }

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class RegistryHandleRename {
  const uint GENERIC_READ = 0x80000000;
  const uint DELETE = 0x00010000;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint OPEN_EXISTING = 3;
  const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  const int FileRenameInfo = 3;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, IntPtr information, uint size);

  public static bool MoveIfHashMatches(string source, string destination, string expectedHash) {
    byte[] reviewedBytes;
    using (SafeFileHandle handle = CreateFileW(source, GENERIC_READ | DELETE, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      using (FileStream stream = new FileStream(handle, FileAccess.Read, 4096, false)) {
        using (MemoryStream copy = new MemoryStream()) { stream.CopyTo(copy); reviewedBytes = copy.ToArray(); }
        string hash;
        using (SHA256 sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(reviewedBytes)).Replace("-", "").ToLowerInvariant();
        if (!String.Equals(hash, expectedHash, StringComparison.OrdinalIgnoreCase)) return false;
        if (File.Exists(destination)) throw new IOException("Destination already exists.");

        byte[] name = Encoding.Unicode.GetBytes(destination);
        int pointerSize = IntPtr.Size;
        int rootOffset = pointerSize == 8 ? 8 : 4;
        int lengthOffset = rootOffset + pointerSize;
        int nameOffset = lengthOffset + 4;
        // Keep a WCHAR terminator after the documented byte-length payload. Some
        // Windows builds read the flexible-array field through the terminator.
        int totalSize = nameOffset + name.Length + sizeof(char);
        IntPtr info = Marshal.AllocHGlobal(totalSize);
        try {
          for (int i = 0; i < totalSize; i++) Marshal.WriteByte(info, i, 0);
          Marshal.WriteInt32(info, 0); // ReplaceIfExists=false and Flags=0.
          Marshal.WriteIntPtr(info, rootOffset, IntPtr.Zero);
          Marshal.WriteInt32(info, lengthOffset, name.Length);
          Marshal.Copy(name, 0, IntPtr.Add(info, nameOffset), name.Length);
          if (!SetFileInformationByHandle(handle, FileRenameInfo, info, (uint)totalSize)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(info); }
      }
    }
    if (File.Exists(source) || !File.Exists(destination)) throw new IOException("Handle-bound rename postcondition failed.");
    byte[] moved = File.ReadAllBytes(destination);
    string movedHash;
    using (SHA256 sha = SHA256.Create()) movedHash = BitConverter.ToString(sha.ComputeHash(moved)).Replace("-", "").ToLowerInvariant();
    if (!String.Equals(movedHash, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("Moved registration digest differs from the reviewed snapshot.");
    return true;
  }
}
'@

$moved = [RegistryHandleRename]::MoveIfHashMatches($sourcePath, $destinationPath, $ExpectedSha256)
if (-not $moved) { throw 'Registry contents changed while acquiring the exclusive file handle; no move was made.' }
Write-Output 'MOVED'

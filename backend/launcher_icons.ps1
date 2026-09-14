# Read the Windows shell's icon without opening the saved launch target.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LauncherShellIcon {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Info {
        public IntPtr Icon;
        public int Index;
        public uint Attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string DisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string TypeName;
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfo(string path, uint attributes, ref Info info, uint size, uint flags);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr icon);
}
'@
$paths = ConvertFrom-Json ([Console]::In.ReadToEnd())
$result = @{}
foreach ($target in $paths) {
    $info = New-Object LauncherShellIcon+Info
    $icon = $null; $bitmap = $null; $stream = $null
    try {
        $size = [Runtime.InteropServices.Marshal]::SizeOf($info)
        $handle = [LauncherShellIcon]::SHGetFileInfo($target, 0, [ref]$info, $size, 0x100)
        if ($handle -eq [IntPtr]::Zero -or $info.Icon -eq [IntPtr]::Zero) { continue }
        $icon = [Drawing.Icon]::FromHandle($info.Icon)
        $bitmap = $icon.ToBitmap()
        $stream = New-Object IO.MemoryStream
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $result[$target] = [Convert]::ToBase64String($stream.ToArray())
    } catch {
        # Missing associations or unavailable shortcuts use the frontend fallback.
    } finally {
        if ($stream) { $stream.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
        if ($icon) { $icon.Dispose() }
        if ($info.Icon -ne [IntPtr]::Zero) { [void][LauncherShellIcon]::DestroyIcon($info.Icon) }
    }
}
ConvertTo-Json -InputObject $result -Compress

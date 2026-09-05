# Synthetic QA label, not an actual product or a certification.
Add-Type -AssemblyName System.Drawing
$bitmap=[System.Drawing.Bitmap]::new(1200,500)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::White)
$font=[System.Drawing.Font]::new('Microsoft YaHei',32)
$lines=@('测试标签（虚构产品，仅供流程验收）','成分：水、甘油、烟酰胺、泛醇、透明质酸钠。','用途：日常保湿。','不宣称治疗疾病；请勿当作实际产品检测报告。')
for($i=0;$i -lt $lines.Length;$i++){$graphics.DrawString($lines[$i],$font,[System.Drawing.Brushes]::Black,30,(35+$i*110))}
$outputDir=Join-Path $PSScriptRoot '..\outputs'
[IO.Directory]::CreateDirectory($outputDir)|Out-Null
$bitmap.Save((Join-Path $outputDir 'ingredient-label-fixture.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$font.Dispose();$graphics.Dispose();$bitmap.Dispose()
Write-Output 'Synthetic label fixture created in outputs.'

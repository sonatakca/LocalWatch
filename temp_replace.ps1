 = Get-Content -Raw server.js;  =  -replace 'movePath\(', 'movePathSync('; Set-Content server.js 

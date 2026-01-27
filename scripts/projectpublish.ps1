docker run --name ai-learning-postgres -e POSTGRES_PASSWORD=devpwd -e POSTGRES_USER=dev -e POSTGRES_DB=ai_learning -p 5432:5432 -d postgres:15

Get-Process -Id (Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object -ExpandProperty OwningProcess) -ErrorAction SilentlyContinue | Stop-Process -Force
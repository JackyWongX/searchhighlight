@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo 开始打包 VS Code 扩展...

:: 确保依赖已安装
echo 正在安装依赖...
call npm install
if errorlevel 1 (
    echo 依赖安装失败，请检查错误信息。
    exit /b 1
)

:: 运行打包命令
:: 注意：必须用 @vscode/vsce，旧的 vsce 包已废弃且存在图标校验缺陷
echo 开始打包扩展...
call npx --yes @vscode/vsce@latest package

:: 检查打包结果
if errorlevel 1 (
    echo 打包失败，请检查错误信息。
    exit /b 1
)

echo 打包成功完成！
:: 列出生成的 vsix 文件
echo 生成的 vsix 文件:
dir /b *.vsix

echo 打包过程完成。
endlocal

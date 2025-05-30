@echo off
echo 开始打包 VS Code 扩展...

:: 确保依赖已安装
echo 正在安装依赖...
call npm install

:: 安装 vsce 如果不存在
echo 检查 vsce 是否已安装...
call npx vsce --version >nul 2>&1
if %errorlevel% neq 0 (
    echo 正在安装 @vscode/vsce...
    call npm install -g @vscode/vsce
)

:: 运行打包命令
echo 开始打包扩展...
call npx vsce package

:: 检查打包结果
if %errorlevel% neq 0 (
    echo 打包失败，请检查错误信息。
    exit /b %errorlevel%
) else (
    echo 打包成功完成！
    :: 列出生成的 vsix 文件
    echo 生成的 vsix 文件:
    dir /b *.vsix
)

echo 打包过程完成。

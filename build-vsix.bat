@echo off
echo ��ʼ��� VS Code ��չ...

:: ȷ�������Ѱ�װ
echo ���ڰ�װ����...
call npm install

:: ��װ vsce ���������
echo ��� vsce �Ƿ��Ѱ�װ...
call npx vsce --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ���ڰ�װ @vscode/vsce...
    call npm install -g @vscode/vsce
)

:: ���д������
echo ��ʼ�����չ...
call npx vsce package

:: ��������
if %errorlevel% neq 0 (
    echo ���ʧ�ܣ����������Ϣ��
    exit /b %errorlevel%
) else (
    echo ����ɹ���ɣ�
    :: �г����ɵ� vsix �ļ�
    echo ���ɵ� vsix �ļ�:
    dir /b *.vsix
)

echo ���������ɡ�

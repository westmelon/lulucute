using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Windows.Forms;

[DataContract]
class StartupInfo
{
    [DataMember(Name = "endpoint")] public string Endpoint;
    [DataMember(Name = "token")] public string Token;
    [DataMember(Name = "extensionDirectory")] public string ExtensionDirectory;
    [DataMember(Name = "downloadRoot")] public string DownloadRoot;
    [DataMember(Name = "firstSetup")] public bool FirstSetup;
    [DataMember(Name = "registrationError")] public string RegistrationError;
}

class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        bool check = args.Length == 1 && args[0] == "--check";
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe")) {
                Arguments = "\"" + Path.Combine(root, "scripts", "portable-launcher.mjs") + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            StartupInfo info;
            using (var process = Process.Start(start))
            {
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(40000))
                {
                    process.Kill();
                    throw new Exception("服务启动超时，请查看 .data/server.log。");
                }
                if (process.ExitCode != 0) throw new Exception(stderr.Result);
                var serializer = new DataContractJsonSerializer(typeof(StartupInfo));
                using (var data = new MemoryStream(Encoding.UTF8.GetBytes(stdout.Result)))
                    info = (StartupInfo)serializer.ReadObject(data);
            }
            if (check)
            {
                if (!String.IsNullOrEmpty(info.RegistrationError)) Console.Error.WriteLine(info.RegistrationError);
                return String.IsNullOrEmpty(info.RegistrationError) ? 0 : 1;
            }
            Application.EnableVisualStyles();
            if (info.FirstSetup || !String.IsNullOrEmpty(info.RegistrationError)) ShowSetup(info);
            Process.Start(new ProcessStartInfo(info.Endpoint) { UseShellExecute = true });
            return 0;
        }
        catch (Exception error)
        {
            if (check) Console.Error.WriteLine(error.Message);
            if (!check) MessageBox.Show("无法启动 lulucute：\n" + error.Message +
                "\n\n请保留完整的便携包目录，并确认该目录可写。", "lulucute", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static void ShowSetup(StartupInfo info)
    {
        using (var form = new Form())
        {
            form.Text = "lulucute · 首次连接";
            form.Font = SystemFonts.MessageBoxFont;
            form.ClientSize = new Size(680, 330);
            form.Padding = new Padding(16);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            var instructions = new TextBox {
                Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None,
                ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill,
                Text = "本地服务已启动。\r\n下载目录：" + info.DownloadRoot +
                    "\r\n\r\n在 chrome://extensions/ 启用开发者模式，加载此目录：\r\n" + info.ExtensionDirectory +
                    "\r\n\r\n在扩展连接设置中填写服务地址：" + info.Endpoint +
                    "\r\n复制下方令牌并保存。以后打开扩展即可自动启动服务。" +
                    (String.IsNullOrEmpty(info.RegistrationError) ? "" :
                        "\r\n\r\n启动器注册失败，暂可使用网页界面；请修复后再次双击 EXE：\r\n" + info.RegistrationError)
            };
            var footer = new Panel { Dock = DockStyle.Bottom, Height = 80 };
            var token = new TextBox { Text = info.Token, ReadOnly = true, Dock = DockStyle.Top };
            var copy = new Button { Text = "复制令牌", Location = new Point(430, 40), Size = new Size(96, 30) };
            copy.Click += delegate { Clipboard.SetText(info.Token); };
            var close = new Button { Text = "打开界面", Location = new Point(538, 40), Size = new Size(96, 30), DialogResult = DialogResult.OK };
            footer.Controls.Add(token);
            footer.Controls.Add(copy);
            footer.Controls.Add(close);
            form.Controls.Add(instructions);
            form.Controls.Add(footer);
            form.AcceptButton = close;
            form.CancelButton = close;
            form.ShowDialog();
        }
    }
}

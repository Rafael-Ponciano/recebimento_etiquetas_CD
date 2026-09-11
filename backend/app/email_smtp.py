from __future__ import annotations

import html
import smtplib
from email.message import EmailMessage

from .config import settings


def enviar_email(
    destinatario: str,
    assunto: str,
    corpo_texto: str,
    corpo_html: str | None = None,
) -> None:
    if not settings.smtp_configurado:
        raise RuntimeError(
            "SMTP não configurado. Preencha SMTP_USER e SMTP_PASSWORD no config.ini."
        )

    msg = EmailMessage()
    msg["Subject"] = assunto
    msg["From"] = settings.smtp_from
    msg["To"] = destinatario
    msg.set_content(corpo_texto)
    if corpo_html:
        msg.add_alternative(corpo_html, subtype="html")

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as smtp:
        if settings.smtp_use_tls:
            smtp.starttls()
        smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(msg)


def _html_recuperacao(nome: str, codigo: str) -> str:
    nome_safe = html.escape(nome)
    codigo_safe = html.escape(codigo)
    digitos = "".join(
        f'<td style="padding:0 4px;">'
        f'<div style="width:40px;height:48px;line-height:48px;text-align:center;'
        f"font-family:'IBM Plex Mono',Consolas,monospace;font-size:22px;font-weight:600;"
        f'letter-spacing:0;color:#0a0d11;background:#f2a63c;border-radius:10px;">'
        f"{d}</div></td>"
        for d in codigo_safe
    )
    return f"""\
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recuperação de senha</title>
</head>
<body style="margin:0;padding:0;background:#0a0d11;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0d11;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#12161d;border:1px solid #1d232d;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:3px;background:linear-gradient(90deg,transparent,#f2a63c,transparent);font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:36px 32px 12px;text-align:center;">
              <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:#4a3a20;color:#f2a63c;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">
                Conferência CD
              </div>
              <h1 style="margin:20px 0 0;font-family:'DM Sans',Inter,Segoe UI,sans-serif;font-size:22px;font-weight:600;letter-spacing:-0.02em;color:#eef2f7;">
                Recuperação de senha
              </h1>
              <p style="margin:10px 0 0;font-size:14px;line-height:1.5;color:#9aa6b5;">
                Olá, <span style="color:#eef2f7;font-weight:500;">{nome_safe}</span> — use o código abaixo no app.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px;" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>{digitos}</tr>
              </table>
              <p style="margin:16px 0 0;font-size:12px;color:#6b7585;">
                Válido por <strong style="color:#f2a63c;">15 minutos</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px;">
              <div style="padding:14px 16px;border-radius:12px;background:#1a2029;border:1px solid #262e3a;">
                <p style="margin:0;font-size:12px;line-height:1.55;color:#9aa6b5;">
                  Se você não pediu esta recuperação, ignore este e-mail. Sua senha permanece a mesma.
                </p>
              </div>
              <p style="margin:22px 0 0;text-align:center;font-size:11px;color:#6b7585;">
                Peça Aí · Conferência CD
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def enviar_codigo_recuperacao(destinatario: str, nome: str, codigo: str) -> None:
    assunto = "Conferência CD — código de recuperação de senha"
    corpo_texto = (
        f"Olá, {nome}!\n\n"
        f"Seu código de recuperação de senha é: {codigo}\n\n"
        "Ele é válido por 15 minutos.\n"
        "Se você não pediu esta recuperação, ignore este e-mail.\n\n"
        "— Conferência CD"
    )
    enviar_email(
        destinatario,
        assunto,
        corpo_texto,
        corpo_html=_html_recuperacao(nome, codigo),
    )

#!/usr/bin/env bash
# telegram.sh — interactive Telegram bot setup
#
# Source this from install.sh or run.sh:
#   source scripts/setup/telegram.sh
#
# Requires: colors.sh sourced first
#
# Functions:
#   has_telegram ENV_FILE        — returns 0 if Telegram token is set in .env
#   setup_telegram ENV_FILE      — interactive Telegram bot setup
#                                  Sets: TELEGRAM_TOKEN, TELEGRAM_USER_ID
#   write_telegram_to_env ENV_FILE — appends Telegram config to the given .env file

has_telegram() {
    local env_file="$1"
    [ -f "$env_file" ] || return 1
    local val
    val=$(sed -n 's/^DINA_TELEGRAM_TOKEN=\(.*\)$/\1/p' "$env_file" 2>/dev/null || true)
    [ -n "$val" ]
}

setup_telegram() {
    local env_file="$1"
    TELEGRAM_TOKEN=""
    TELEGRAM_USER_ID=""

    if has_telegram "$env_file"; then
        skip "Telegram bot already configured in .env"
        return
    fi

    [ -t 0 ] || return  # skip in non-interactive mode

    echo ""
    echo -e "  ${BOLD}Would you like to connect to a Telegram bot?${RESET}"
    echo -e "  ${DIM}Dina can chat with you via Telegram — fully optional.${RESET}"
    echo ""
    echo -e "    ${CYAN}1)${RESET} Yes — I have a bot token (or will create one now)"
    echo -e "    ${CYAN}2)${RESET} Skip ${DIM}(you can set this up later in .env)${RESET}"
    echo ""
    printf "  Enter choice [1-2]: "
    local tg_choice
    read -r tg_choice

    if [ "${tg_choice}" = "1" ]; then
        echo ""
        echo -e "  ${BOLD}Step A: Create a Telegram bot${RESET}"
        echo -e "    1. Open Telegram and message ${CYAN}@BotFather${RESET}"
        echo -e "    2. Send ${CYAN}/newbot${RESET} and follow the prompts"
        echo -e "    3. Copy the token (looks like ${DIM}123456:ABC-DEF...${RESET})"
        echo ""
        printf "  Enter your bot token: "
        read -r TELEGRAM_TOKEN
        TELEGRAM_TOKEN=$(echo "${TELEGRAM_TOKEN}" | tr -d '[:space:]')

        if [ -n "${TELEGRAM_TOKEN}" ]; then
            echo ""
            echo -e "  ${BOLD}Step B: Get your Telegram user ID${RESET}"
            echo -e "    1. Message ${CYAN}@userinfobot${RESET} on Telegram"
            echo -e "    2. It will reply with your numeric ID (e.g. ${DIM}987654321${RESET})"
            echo ""
            printf "  Enter your Telegram user ID: "
            read -r TELEGRAM_USER_ID
            TELEGRAM_USER_ID=$(echo "${TELEGRAM_USER_ID}" | tr -d '[:space:]')

            if [ -n "${TELEGRAM_USER_ID}" ]; then
                ok "Telegram bot configured (token + user ID)"
            else
                warn "No user ID entered — bot will reject all messages until DINA_TELEGRAM_ALLOWED_USERS is set in .env"
            fi
        else
            info "No token entered — skipping Telegram setup"
            TELEGRAM_TOKEN=""
        fi
    fi
}

write_telegram_to_env() {
    local env_file="$1"
    if [ -n "${TELEGRAM_TOKEN}" ]; then
        echo "" >> "${env_file}"
        echo "# Telegram Bot" >> "${env_file}"
        echo "DINA_TELEGRAM_TOKEN=${TELEGRAM_TOKEN}" >> "${env_file}"
        if [ -n "${TELEGRAM_USER_ID}" ]; then
            echo "DINA_TELEGRAM_ALLOWED_USERS=${TELEGRAM_USER_ID}" >> "${env_file}"
        fi
    fi
}

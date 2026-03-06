#!/usr/bin/env bash
# llm_provider.sh — interactive LLM provider selection and API key validation
#
# Source this from install.sh or run.sh:
#   source scripts/setup/llm_provider.sh
#
# Requires: colors.sh sourced first
#
# Functions:
#   has_llm_provider ENV_FILE  — returns 0 if any LLM provider key is set
#   setup_llm_provider         — interactive provider selection + validation
#                                Sets: LLM_KEY_NAME, LLM_KEY_VALUE, LLM_EXTRA_LINES
#   write_llm_to_env ENV_FILE  — appends LLM config to the given .env file

has_llm_provider() {
    local env_file="$1"
    [ -f "$env_file" ] || return 1
    local key val
    for key in GEMINI_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY; do
        val=$(sed -n "s/^${key}=\(.*\)$/\1/p" "$env_file" 2>/dev/null || true)
        if [ -n "$val" ]; then
            return 0
        fi
    done
    val=$(sed -n 's/^OLLAMA_BASE_URL=\(.*\)$/\1/p' "$env_file" 2>/dev/null || true)
    [ -n "$val" ]
}

setup_llm_provider() {
    LLM_KEY_NAME=""
    LLM_KEY_VALUE=""
    LLM_EXTRA_LINES=""

    echo ""
    echo -e "  ${BOLD}Which LLM provider would you like to use?${RESET}"
    echo ""
    echo -e "    ${CYAN}1)${RESET} Gemini      ${DIM}(Google — free tier available)${RESET}"
    echo -e "    ${CYAN}2)${RESET} OpenAI      ${DIM}(GPT-5.2)${RESET}"
    echo -e "    ${CYAN}3)${RESET} Claude      ${DIM}(Anthropic)${RESET}"
    echo -e "    ${CYAN}4)${RESET} OpenRouter  ${DIM}(access 200+ models via one key)${RESET}"
    echo -e "    ${CYAN}5)${RESET} Ollama      ${DIM}(local models, fully private — no API key needed)${RESET}"
    echo -e "    ${CYAN}6)${RESET} Skip        ${DIM}(configure later in .env)${RESET}"
    echo ""

    local provider_choice=""

    if [ -t 0 ]; then
        printf "  Enter choice [1-6]: "
        read -r provider_choice
    else
        provider_choice="6"
        info "Non-interactive mode — skipping provider selection"
    fi

    case "${provider_choice}" in
        1)
            LLM_KEY_NAME="GEMINI_API_KEY"
            echo ""
            echo -e "  Get a free key at: ${CYAN}https://aistudio.google.com/apikey${RESET}"
            printf "  Enter your Gemini API key: "
            read -r LLM_KEY_VALUE
            ;;
        2)
            LLM_KEY_NAME="OPENAI_API_KEY"
            echo ""
            echo -e "  Get a key at: ${CYAN}https://platform.openai.com/api-keys${RESET}"
            printf "  Enter your OpenAI API key: "
            read -r LLM_KEY_VALUE
            ;;
        3)
            LLM_KEY_NAME="ANTHROPIC_API_KEY"
            echo ""
            echo -e "  Get a key at: ${CYAN}https://console.anthropic.com/${RESET}"
            printf "  Enter your Anthropic API key: "
            read -r LLM_KEY_VALUE
            ;;
        4)
            LLM_KEY_NAME="OPENROUTER_API_KEY"
            LLM_EXTRA_LINES="OPENROUTER_MODEL=google/gemini-2.5-flash"
            echo ""
            echo -e "  Get a key at: ${CYAN}https://openrouter.ai/keys${RESET}"
            printf "  Enter your OpenRouter API key: "
            read -r LLM_KEY_VALUE
            ;;
        5)
            LLM_KEY_NAME="OLLAMA_BASE_URL"
            LLM_KEY_VALUE="http://localhost:11434"
            echo ""
            echo -e "  ${DIM}Using local Ollama at http://localhost:11434${RESET}"
            echo -e "  ${DIM}Make sure Ollama is running: ollama serve${RESET}"
            ;;
        *)
            info "Skipping provider setup — edit .env later to add your API key"
            ;;
    esac

    # Validate API key by sending a tiny completion through the real provider.
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ] && [ -t 0 ] && command -v python3 &>/dev/null; then
        while true; do
            printf "  Validating API key (sending a test completion)... "
            local validate_err
            validate_err=$(python3 scripts/validate_key.py "${LLM_KEY_NAME}" "${LLM_KEY_VALUE}" 2>&1)
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓${RESET} Key works"
                break
            else
                echo -e "${YELLOW}✗${RESET} Key did not work"
                if [ -n "${validate_err}" ]; then
                    echo -e "  ${DIM}${validate_err}${RESET}"
                fi
                echo ""
                echo -e "    ${CYAN}1)${RESET} Re-enter key"
                echo -e "    ${CYAN}2)${RESET} Continue without a key  ${DIM}(you can add it to .env later)${RESET}"
                echo -e "    ${CYAN}3)${RESET} Exit"
                echo ""
                printf "  What would you like to do? [1-3]: "
                local retry_choice
                read -r retry_choice
                case "${retry_choice}" in
                    1)
                        printf "  Enter your API key: "
                        read -r LLM_KEY_VALUE
                        if [ -z "${LLM_KEY_VALUE}" ]; then
                            info "Empty key — continuing without provider"
                            LLM_KEY_NAME=""
                            LLM_KEY_VALUE=""
                            break
                        fi
                        ;;
                    3)
                        echo ""
                        info "Exiting. Re-run when ready."
                        exit 0
                        ;;
                    *)
                        info "Continuing without validated key — edit .env later"
                        LLM_KEY_NAME=""
                        LLM_KEY_VALUE=""
                        break
                        ;;
                esac
            fi
        done
    fi
}

write_llm_to_env() {
    local env_file="$1"
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ]; then
        echo "" >> "${env_file}"
        echo "# LLM Provider" >> "${env_file}"
        echo "${LLM_KEY_NAME}=${LLM_KEY_VALUE}" >> "${env_file}"
        if [ -n "${LLM_EXTRA_LINES}" ]; then
            echo "${LLM_EXTRA_LINES}" >> "${env_file}"
        fi
    fi
}
